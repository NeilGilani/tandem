// The office: what makes a team of Bots run like a real company.
//   Channels  — #general and a channel per department, where Bots post updates in the open
//   Meetings  — recurring meetings where Bots talk in turns, decide, and leave with assignments
//   Goals     — company, department and personal goals with live numbers
//   Reviews   — monthly reviews: each boss reviews its reports and coaches them
//   Handbook  — the company's source of truth every Bot follows
import fs from 'node:fs';
import path from 'node:path';
import { db, all, get, run, uid, now, setting, timezone, parseRow, PATHS } from './db.js';
import { emit } from './bus.js';
import * as chats from './chats.js';
import * as memory from './memory.js';
import * as company from './company.js';
import * as cron from './cron.js';
import * as activity from './activity.js';

db.exec(`
CREATE TABLE IF NOT EXISTS meetings (
  id TEXT PRIMARY KEY, title TEXT, chair_id TEXT, attendees TEXT DEFAULT '[]', agenda TEXT DEFAULT '', schedule_text TEXT, cron TEXT,
  next_run INTEGER, rounds INTEGER DEFAULT 2, chat_id TEXT, status TEXT DEFAULT 'idle', last_run INTEGER, last_minutes TEXT, created INTEGER
);
CREATE TABLE IF NOT EXISTS goals (
  id TEXT PRIMARY KEY, title TEXT, owner_id TEXT, parent_id TEXT, target REAL, current REAL DEFAULT 0, unit TEXT DEFAULT '',
  due TEXT, how TEXT DEFAULT '', notes TEXT DEFAULT '[]', status TEXT DEFAULT 'active', created INTEGER, updated INTEGER
);`);

let engine = null;
export const attach = (e) => { engine = e; };
const bossy = (botId) => /chief|head|ceo|lead|manager/i.test(chats.getBot(botId)?.title || '') || company.reportsOf(botId).length > 0;

// ---- Channels ------------------------------------------------------------------------------
// A channel is a group chat named #something that can hold the whole team.
export const channels = () => chats.listChats().filter((c) => c.kind === 'group' && /^#/.test(c.name || ''));
export const channelByName = (n) => channels().find((c) => c.name.toLowerCase() === `#${String(n).replace(/^#/, '').toLowerCase()}`);

function makeRoom(name, botIds) {
  const ids = [...new Set(botIds)].filter((b) => chats.getBot(b));
  const existing = chats.listChats().find((c) => c.kind === 'group' && c.name === name);
  if (existing) { run('UPDATE chats SET bot_ids = ? WHERE id = ?', JSON.stringify(ids), existing.id); return chats.getChat(existing.id); }
  const id = uid('chat_');
  run('INSERT INTO chats (id, kind, name, bot_ids, created, updated) VALUES (?,?,?,?,?,?)', id, 'group', name, JSON.stringify(ids), now(), now());
  emit('chats');
  return chats.getChat(id);
}

// #general for everyone, and one channel per department (the head, its reports, and the chief).
export function ensureChannels() {
  const bots = chats.listBots();
  if (bots.length < 2) return [];
  const out = [makeRoom('#general', bots.map((b) => b.id))];
  const chief = bots.find((b) => !b.boss_id && company.reportsOf(b.id).length);
  for (const head of bots.filter((b) => b.boss_id && company.reportsOf(b.id).length || (chief && b.boss_id === chief.id))) {
    const dept = (head.title || head.name).replace(/^head of\s+/i, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'team';
    const team = [head.id, ...company.reportsOf(head.id).map((r) => r.id), ...(chief ? [chief.id] : [])];
    out.push(makeRoom(`#${dept}`, team));
  }
  return out;
}

// A Bot posts in a channel. @mentioned teammates are woken to reply there.
export function post(botId, channel, text, depth = 0) {
  const c = channelByName(channel);
  if (!c) throw new Error(`No channel ${channel}. Channels: ${channels().map((x) => x.name).join(', ')}`);
  if (!c.bot_ids.includes(botId)) throw new Error(`You're not in ${c.name}.`);
  const msg = chats.addMessage({ chatId: c.id, author: 'bot', botId, text: String(text).slice(0, 4000) });
  if (depth < 3 && engine) {
    for (const b of c.bot_ids.map(chats.getBot).filter(Boolean)) {
      if (b.id === botId || !new RegExp(`@${b.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text)) continue;
      engine.runBot(b.id, c.id, `[${chats.getBot(botId).name} mentioned you in ${c.name}]\n${recent(c.id, 12)}\n\nReply in the channel (your reply is posted there). Keep it short.`, { origin: 'handoff', depth: depth + 1 }).catch(() => {});
    }
  }
  return msg;
}

export function recent(chatId, n = 20) {
  return chats.messages(chatId, { limit: n }).filter((m) => m.text).map((m) => `${m.author === 'user' ? 'Neil' : m.author === 'system' ? 'System' : chats.getBot(m.bot_id)?.name || 'Bot'}: ${m.text.slice(0, 600)}`).join('\n');
}

// ---- Meetings -------------------------------------------------------------------------
const parseMt = (r) => parseRow(r, ['attendees']);
export const meetings = () => all('SELECT * FROM meetings ORDER BY next_run').map(parseMt);
export const getMeeting = (id) => parseMt(get('SELECT * FROM meetings WHERE id = ?', id));

export async function schedule({ title, chairId, attendees = [], agenda = '', when = '', rounds = 2 }) {
  if (!chats.getBot(chairId)) throw new Error('Pick who chairs the meeting');
  const people = [...new Set([chairId, ...attendees])].filter((b) => chats.getBot(b));
  if (people.length < 2) throw new Error('A meeting needs at least two attendees');
  let c = null, next = null, text = '';
  if (when) {
    const r = await import('./routines.js').then((m) => m.interpret(when));
    c = r.cron; text = r.when || when;
    next = cron.next(c, timezone());
  }
  const id = uid('mtg_');
  const room = makeRoom(`Meeting: ${title}`, people);
  run('INSERT INTO meetings (id, title, chair_id, attendees, agenda, schedule_text, cron, next_run, rounds, chat_id, created) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    id, title, chairId, JSON.stringify(people), agenda, text, c, next, Math.max(1, Math.min(3, Number(rounds) || 2)), room.id, now());
  emit('company');
  return getMeeting(id);
}

export function removeMeeting(id) { run('DELETE FROM meetings WHERE id = ?', id); emit('company'); }

// Run a meeting: the chair opens, everyone speaks in turns, the chair closes with decisions
// and assigns the action items. Neil can join by posting in the meeting room.
const running = new Set();
export async function runMeeting(id) {
  const mt = getMeeting(id);
  if (!mt || running.has(id) || !engine) return;
  running.add(id);
  run("UPDATE meetings SET status = 'running', last_run = ? WHERE id = ?", now(), id);
  emit('company');
  const room = chats.getChat(mt.chat_id) || makeRoom(`Meeting: ${mt.title}`, mt.attendees);
  const start = chats.addMessage({ chatId: room.id, author: 'system', text: `${mt.title} started. ${mt.attendees.map((b) => chats.getBot(b)?.name).filter(Boolean).join(', ')}.`, meta: { kind: 'meeting', meetingId: id } });
  const since = () => chats.messages(room.id, { limit: 80 }).filter((m) => m.created >= start.created && m.text && m.id !== start.id)
    .map((m) => `${m.author === 'user' ? 'Neil' : m.author === 'system' ? '' : chats.getBot(m.bot_id)?.name}: ${m.text.slice(0, 1200)}`).filter((l) => !l.startsWith(':')).join('\n\n');
  const goalsText = scoreboard();
  const ROOM = '\n\nYou are in the meeting room right now: just reply with what you say. Don\'t post in channels or message other Bots during the meeting.';
  const speak = (botId, text) => engine.runBot(botId, room.id, text + ROOM, { origin: 'meeting', depth: 1 }).catch(() => {});
  try {
    await speak(mt.chair_id, `[You're chairing "${mt.title}" now, with ${mt.attendees.filter((b) => b !== mt.chair_id).map((b) => chats.getBot(b)?.name).join(', ')}.]
Agenda: ${mt.agenda || 'Each person: progress since last time, numbers, blockers, and what they need from others. Then decide priorities.'}
${goalsText ? `Goals scoreboard:\n${goalsText}\n` : ''}${mt.last_minutes ? `Last meeting's minutes:\n${mt.last_minutes.slice(0, 1500)}\n` : ''}
Open the meeting in 3 to 6 lines: what we need to decide today, using current facts. This is posted in the meeting room.`);
    for (let r = 0; r < mt.rounds; r++) {
      for (const b of mt.attendees.filter((x) => x !== mt.chair_id)) {
        await speak(b, `[Meeting "${mt.title}", your turn${r ? ' (round 2: respond to others, settle open questions)' : ''}. What's been said:]
${since()}

Speak in under 120 words: facts and numbers from your work, blockers, what you need from whom, and your view on what's being decided. Respond to the others by name. Don't use tools unless you must check a fact. Your reply is posted in the meeting room.`);
      }
    }
    const res = await speak(mt.chair_id, `[Close "${mt.title}". The whole meeting:]
${since()}

1. For every action item, call assign_task (owner, title, detail, due). You can assign to anyone in this meeting.
2. Then reply with the minutes: Decisions, Action items (owner, due), Open questions for Neil. Short and plain. They're posted in the meeting room.`);
    const minutes = res?.text || '';
    run('UPDATE meetings SET last_minutes = ? WHERE id = ?', minutes, id);
    activity.log({ botId: mt.chair_id, kind: 'meeting', summary: `Meeting held: ${mt.title}`, detail: minutes.slice(0, 1500), status: 'ok', origin: 'company' });
    emit('notify', { botId: mt.chair_id, chatId: room.id, title: `${mt.title}: minutes`, body: minutes.slice(0, 160) });
  } finally {
    running.delete(id);
    const cur = getMeeting(id);
    run("UPDATE meetings SET status = 'idle', next_run = ? WHERE id = ?", cur?.cron ? cron.next(cur.cron, timezone()) : null, id);
    emit('company');
  }
}

export function tickMeetings() {
  for (const m of meetings()) if (m.next_run && m.next_run <= now() && m.status !== 'running') runMeeting(m.id);
}

// ---- Goals --------------------------------------------------------------------------------
const parseGoal = (r) => parseRow(r, ['notes']);
export const goals = () => all("SELECT * FROM goals WHERE status != 'dropped' ORDER BY parent_id IS NOT NULL, created").map(parseGoal);
export const getGoal = (id) => parseGoal(get('SELECT * FROM goals WHERE id = ?', id));

export function setGoal({ id, title, ownerId = null, parentId = null, target, current, unit = '', due = null, how = '', by = 'user' }) {
  if (by !== 'user' && !bossy(by)) throw new Error('Only the chief of staff and department heads set goals. Propose it to your boss.');
  if (id) {
    const g = getGoal(id);
    if (!g) throw new Error('No such goal');
    run('UPDATE goals SET title = coalesce(?, title), target = coalesce(?, target), current = coalesce(?, current), unit = coalesce(?, unit), due = coalesce(?, due), how = coalesce(?, how), owner_id = coalesce(?, owner_id), updated = ? WHERE id = ?',
      title ?? null, target ?? null, current ?? null, unit || null, due || null, how || null, ownerId || null, now(), id);
  } else {
    if (!String(title || '').trim() || !(Number(target) > 0)) throw new Error('A goal needs a title and a target number');
    id = uid('goal_');
    run('INSERT INTO goals (id, title, owner_id, parent_id, target, current, unit, due, how, created, updated) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      id, String(title).trim().slice(0, 120), ownerId, parentId, Number(target), Number(current) || 0, unit, due, how, now(), now());
  }
  emit('company');
  return getGoal(id);
}

export function updateGoal(id, { current, note, by }) {
  const g = getGoal(id);
  if (!g) throw new Error('No such goal');
  if (current != null && !Number.isNaN(Number(current))) run('UPDATE goals SET current = ?, updated = ?, status = ? WHERE id = ?', Number(current), now(), Number(current) >= g.target ? 'done' : 'active', id);
  if (note) run('UPDATE goals SET notes = ? WHERE id = ?', JSON.stringify([...(g.notes || []), { at: now(), by, text: String(note).slice(0, 600), value: current ?? null }].slice(-30)), id);
  emit('company');
  return getGoal(id);
}

export function scoreboard() {
  return goals().map((g) => `- ${g.title}: ${g.current}${g.unit ? ` ${g.unit}` : ''} of ${g.target}${g.due ? `, due ${g.due}` : ''}${g.owner_id ? ` (${chats.getBot(g.owner_id)?.name})` : ''} [id ${g.id}]`).join('\n');
}

// ---- Monthly reviews ------------------------------------------------------------------------
export function runReviews() {
  if (!engine) return 0;
  const ts = company.timesheet({ days: 30 });
  let n = 0;
  for (const boss of chats.listBots()) {
    const reps = company.reportsOf(boss.id);
    if (!reps.length) continue;
    const lines = reps.map((r) => {
      const t = ts.find((x) => x.botId === r.id) || {};
      const g = goals().filter((x) => x.owner_id === r.id).map((x) => `${x.title} ${x.current}/${x.target}`).join('; ');
      return `- ${r.name} (${r.title || 'no title'}): worked ${t.minutes || 0} min in ${t.sessions || 0} sessions, ${t.tasksDone || 0} assignments done, ${t.sentBack || 0} sent back, ${t.drafts || 0} drafts${g ? `; goals: ${g}` : ''}`;
    }).join('\n');
    engine.runInOffice(boss.id, `[Monthly reviews] Review each of your direct reports for the past month:\n${lines}\n\n` +
      'For each one, look at their real work (their chat, assignments, drafts, goals), then call write_review with a rating from 1 to 5, ' +
      'what went well, what to improve, and one concrete coaching change. The coaching is saved to their memory, so make it specific and actionable.', { origin: 'handoff' }).catch(() => {});
    n++;
  }
  run("INSERT INTO settings (key, value) VALUES ('last_reviews', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", new Date().toISOString().slice(0, 7));
  return n;
}

export function writeReview(byId, { bot, rating, went_well = '', improve = '', coaching = '' }) {
  const r = chats.findBot(bot);
  if (!r) throw new Error(`No Bot named ${bot}`);
  if (company.bossOf(r.id)?.id !== byId) throw new Error(`${r.name} doesn't report to you.`);
  const stars = Math.max(1, Math.min(5, Math.round(Number(rating) || 3)));
  company.postReport(r.id, 'review', `Rating ${stars}/5 from ${chats.getBot(byId).name}\n\nWent well: ${went_well}\n\nImprove: ${improve}\n\nCoaching: ${coaching}`);
  if (coaching) memory.remember(r.id, `Coaching from ${chats.getBot(byId).name} (${new Date().toISOString().slice(0, 10)} review): ${coaching}`);
  return `Review saved for ${r.name}${coaching ? '; the coaching is in their memory' : ''}.`;
}

// First weekday of the month, after 10am: reviews run once.
export function tickReviews() {
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: timezone() }));
  if (d.getDate() > 3 || d.getDay() === 0 || d.getDay() === 6 || d.getHours() < 10) return;
  if (setting('last_reviews') === d.toISOString().slice(0, 7)) return;
  if (!company.org().some((o) => o.reports.length)) return;
  runReviews();
}

// ---- Handbook -----------------------------------------------------------------------------
export const handbookPath = () => path.join(PATHS.shared, 'handbook.md');
export function handbook() { try { return fs.readFileSync(handbookPath(), 'utf8'); } catch { return ''; } }

export function updateHandbook(byId, section, text) {
  if (byId !== 'user' && !bossy(byId)) throw new Error('Only the chief of staff and department heads edit the handbook. Suggest the change to your boss.');
  const name = String(section || '').trim().replace(/^#+\s*/, '');
  if (!name) throw new Error('Name the section');
  let doc = handbook() || `# ${company.companyName() || 'Company'} handbook\n\nHow we work. Every Bot follows this. If something here is wrong, tell your boss.\n`;
  const block = `## ${name}\n${String(text).trim()}\n`;
  const re = new RegExp(`^## ${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n[\\s\\S]*?(?=^## |\\Z)`, 'm');
  doc = re.test(doc) ? doc.replace(re, `${block}\n`) : `${doc.trimEnd()}\n\n${block}`;
  fs.writeFileSync(handbookPath(), doc);
  activity.log({ botId: byId === 'user' ? null : byId, kind: 'handbook', summary: `Handbook updated: ${name}`, status: 'ok', origin: 'company' });
  emit('company');
  return `Updated the "${name}" section of the handbook.`;
}

// ---- What every Bot sees -------------------------------------------------------------
export function promptBlock(bot) {
  const hb = handbook();
  const sb = scoreboard();
  const chans = channels().filter((c) => c.bot_ids.includes(bot.id)).map((c) => c.name);
  const myMeetings = meetings().filter((m) => m.attendees.includes(bot.id));
  return [
    hb && `## Company handbook (the source of truth; follow it over anything else)\n${hb.slice(0, 5000)}`,
    sb && `## Goals scoreboard\n${sb}\nKeep the numbers you own current with update_goal, from real sources, whenever they change.${bossy(bot.id) ? ' As a lead you can set goals for your team with set_goal.' : ''}`,
    chans.length && `## Channels\nYou're in ${chans.join(', ')}. Post short updates and questions there with post_to_channel (announce wins, ask the team, flag blockers), and @mention a teammate to get their reply. Use message_bot for private one-to-one requests.`,
    myMeetings.length && `## Meetings you attend\n${myMeetings.map((m) => `- ${m.title}${m.schedule_text ? `, ${m.schedule_text}` : ''}${m.chair_id === bot.id ? ' (you chair it)' : ''}`).join('\n')}`,
  ].filter(Boolean).join('\n\n');
}
