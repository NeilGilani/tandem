// Company: the Bots work like a company. Each Bot has a job title and a boss (another Bot,
// or you at the top). Bosses hand out assignments, review their reports' drafts before
// they reach you, and answer what their reports can't; only what needs the founder
// reaches you. Shifts open with a standup and close with an end-of-day report.
import { db, all, get, run, uid, now, setting, timezone, parseRow } from './db.js';
import { emit } from './bus.js';
import * as chats from './chats.js';
import * as activity from './activity.js';
import * as members from './members.js';

for (const col of ['title TEXT', 'boss_id TEXT']) { try { db.exec(`ALTER TABLE bots ADD COLUMN ${col}`); } catch {} }
db.exec(`
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, detail TEXT DEFAULT '', owner_id TEXT NOT NULL, assigned_by TEXT,
  status TEXT DEFAULT 'todo', due TEXT, result TEXT, notes TEXT DEFAULT '[]', reviewer_id TEXT,
  created INTEGER, updated INTEGER, done_at INTEGER
);
CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, day TEXT, kind TEXT, text TEXT, created INTEGER
);`);

let engine = null;
export const attach = (e) => { engine = e; };

export const companyName = () => setting('company_name') || '';
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: timezone() });
const isPerson = (id) => id === 'user' || /^mem_/.test(id || '');
const name = (id) => (id === 'user' || !id ? 'You' : /^mem_/.test(id) ? members.byId(id)?.name || 'A teammate' : chats.getBot(id)?.name || 'A Bot');

// ---- Org ---------------------------------------------------------------------------------
export const bossOf = (botId) => { const b = chats.getBot(botId); return b?.boss_id ? chats.getBot(b.boss_id) : null; };
export const reportsOf = (botId) => chats.listBots().filter((b) => b.boss_id === botId);

export function setRole(botId, { title, bossId }) {
  const b = chats.getBot(botId);
  if (!b) throw new Error('No such Bot');
  if (title !== undefined) run('UPDATE bots SET title = ? WHERE id = ?', String(title || '').slice(0, 60) || null, botId);
  if (bossId !== undefined) {
    const boss = bossId && bossId !== 'user' ? bossId : null;
    if (boss === botId) throw new Error("A Bot can't report to itself");
    for (let cur = boss, i = 0; cur && i < 20; cur = chats.getBot(cur)?.boss_id, i++) if (cur === botId) throw new Error('That would make a loop in the org chart');
    run('UPDATE bots SET boss_id = ? WHERE id = ?', boss, botId);
  }
  emit('bots'); emit('company');
  return chats.getBot(botId);
}

export function org() {
  const bots = chats.listBots();
  return bots.map((b) => ({ id: b.id, name: b.name, title: b.title || b.label || '', bossId: b.boss_id || null, reports: bots.filter((x) => x.boss_id === b.id).map((x) => x.id) }));
}

// ---- Assignments -------------------------------------------------------------------------
const parse = (r) => parseRow(r, ['notes']);
export const getTask = (id) => parse(get('SELECT * FROM tasks WHERE id = ?', id));
export const tasks = ({ ownerId, open } = {}) => all(`SELECT * FROM tasks WHERE 1=1 ${ownerId ? 'AND owner_id = ?' : ''} ${open ? "AND status != 'done'" : 'AND (status != \'done\' OR done_at > ?)'} ORDER BY created DESC LIMIT 200`,
  ...(ownerId ? [ownerId] : []), ...(open ? [] : [now() - 14 * 864e5])).map(parse);

function note(t, by, text) { const notes = [...(t.notes || []), { at: now(), by, text: String(text).slice(0, 2000) }]; run('UPDATE tasks SET notes = ? WHERE id = ?', JSON.stringify(notes), t.id); }

export function assign({ title, detail = '', ownerId, assignedBy = 'user', due = null, wake = true }) {
  const owner = chats.getBot(ownerId) || chats.findBot(ownerId);
  if (!owner) throw new Error(`No Bot named ${ownerId}`);
  if (!String(title || '').trim()) throw new Error('An assignment needs a title');
  if (!isPerson(assignedBy)) {
    const ok = owner.boss_id === assignedBy || chats.getBot(assignedBy)?.title?.match(/chief|ceo|head/i);
    if (!ok) throw new Error(`${owner.name} doesn't report to you. Ask their boss, or message them with message_bot.`);
  }
  const id = uid('task_');
  run('INSERT INTO tasks (id, title, detail, owner_id, assigned_by, status, due, created, updated) VALUES (?,?,?,?,?,?,?,?,?)',
    id, String(title).trim().slice(0, 140), String(detail || '').slice(0, 4000), owner.id, assignedBy, 'todo', due || null, now(), now());
  activity.log({ botId: owner.id, kind: 'task', summary: `Assigned: ${title}`, detail: `From ${name(assignedBy)}${due ? `, due ${due}` : ''}`, status: 'ok', origin: 'company' });
  emit('company');
  if (wake && engine) {
    engine.runInOffice(owner.id, `[New assignment from ${name(assignedBy)}${due ? `, due ${due}` : ''}] ${title}\n${detail}\n\nAssignment id: ${id}. Work it now if it's urgent, or fit it into your shift. Use update_task as you go and submit_task when it's done.`,
      { origin: 'handoff' }).catch(() => {});
  }
  return getTask(id);
}

export function update(id, { status, note: text, by }) {
  const t = getTask(id);
  if (!t) throw new Error('No such assignment');
  if (status && ['todo', 'doing', 'blocked'].includes(status)) run('UPDATE tasks SET status = ?, updated = ? WHERE id = ?', status, now(), id);
  if (text) note(t, by || t.owner_id, text);
  emit('company');
  return getTask(id);
}

// Done: goes to the owner's boss for review, or straight to done if the boss is you.
export function submit(id, { result, by }) {
  const t = getTask(id);
  if (!t) throw new Error('No such assignment');
  const boss = setting('task_reviews') === '1' ? bossOf(t.owner_id) : null;
  run('UPDATE tasks SET result = ?, updated = ? WHERE id = ?', String(result || '').slice(0, 6000), now(), id);
  if (boss) {
    run("UPDATE tasks SET status = 'review', reviewer_id = ? WHERE id = ?", boss.id, id);
    emit('company');
    engine?.runInOffice(boss.id, `[Review an assignment] ${name(t.owner_id)} finished "${t.title}" (id ${id}).\nWhat was asked: ${t.detail || t.title}\nTheir result:\n${String(result || '').slice(0, 4000)}\n\n` +
      'Check it like a good manager: is it complete, correct and sourced, and does it answer what was asked? Open any files it names. ' +
      'Then call review_task with verdict "approve" or "send_back" and clear notes.', { origin: 'handoff' }).catch(() => {});
    return `Sent to ${boss.name} for review.`;
  }
  run("UPDATE tasks SET status = 'done', done_at = ? WHERE id = ?", now(), id);
  activity.log({ botId: t.owner_id, kind: 'task', summary: `Done: ${t.title}`, status: 'ok', origin: 'company' });
  emit('company');
  if (isPerson(t.assigned_by)) emit('notify', { botId: t.owner_id, title: `${name(t.owner_id)} finished`, body: t.title });
  return 'Done.';
}

export function review(id, { verdict, notes = '', by }) {
  const t = getTask(id);
  if (!t) throw new Error('No such assignment');
  if (t.reviewer_id && by !== t.reviewer_id && by !== 'user') throw new Error(`Only ${name(t.reviewer_id)} reviews this one.`);
  if (verdict === 'approve') {
    run("UPDATE tasks SET status = 'done', done_at = ?, updated = ? WHERE id = ?", now(), now(), id);
    if (notes) note(t, by, `Approved: ${notes}`);
    activity.log({ botId: t.owner_id, kind: 'task', summary: `Done: ${t.title}`, detail: `Approved by ${name(by)}`, status: 'ok', origin: 'company' });
  } else {
    run("UPDATE tasks SET status = 'doing', updated = ? WHERE id = ?", now(), id);
    note(t, by, `Sent back: ${notes}`);
    activity.log({ botId: t.owner_id, kind: 'task', summary: `Sent back: ${t.title}`, detail: notes, status: 'error', origin: 'company' });
    engine?.runInOffice(t.owner_id, `[${name(by)} sent your assignment back] "${t.title}" (id ${id})\nNotes: ${notes}\nFix it and submit_task again.`, { origin: 'handoff' }).catch(() => {});
  }
  emit('company');
  return verdict === 'approve' ? 'Approved.' : 'Sent back with your notes.';
}

// ---- Draft review: a report's drafts go to their boss before they reach you -----------------
const REVIEW_TTL = 2 * 3600e3;
export function needsDraftReview(botId) { return setting('draft_reviews') === '1' && !!bossOf(botId); }

export function requestDraftReview(msg, ownerId) {
  const boss = bossOf(ownerId);
  if (!boss || !engine) return;
  const c = msg.card;
  engine.runInOffice(boss.id, `[Review a draft] ${name(ownerId)} drafted this ${c.app} message (card ${msg.id}). It reaches Neil only after you pass it.\n` +
    `To: ${c.to}${c.cc ? `\nCc: ${c.cc}` : ''}${c.subject ? `\nSubject: ${c.subject}` : ''}\n\n${c.body}\n\n` +
    'Check: it belongs in their lane, it is not a duplicate (search Gmail Sent and Drafts for this recipient), every fact is true, ' +
    'and it reads well. Then call review_draft with verdict "approve" (you may fix the subject or body) or "send_back" with notes.', { origin: 'handoff' }).catch(() => {});
}

// Reviews that sit too long go to you anyway, marked as not reviewed.
export function tickDraftReviews() {
  const stale = all("SELECT * FROM messages WHERE card LIKE '%\"status\":\"review\"%'").map(chats.parseMsg)
    .filter((m) => m.card?.status === 'review' && now() - (m.card.reviewSince || m.created) > REVIEW_TTL);
  for (const m of stale) chats.updateMessage(m.id, { card: { ...m.card, status: 'pending', reviewNote: `${m.card.reviewer || 'The boss'} didn't review this in time` } });
}

// ---- Standups and end-of-day reports -------------------------------------------------------
export function postReport(botId, kind, text) {
  run('INSERT INTO reports (id, bot_id, day, kind, text, created) VALUES (?,?,?,?,?,?)', uid('rep_'), botId, today(), kind, String(text).slice(0, 3000), now());
  emit('company');
}
export const reportsFor = (day = today()) => all('SELECT * FROM reports WHERE day = ? ORDER BY created', day);
export const hadStandup = (botId) => !!get("SELECT 1 FROM reports WHERE bot_id = ? AND day = ? AND kind = 'standup'", botId, today());
export const hadEod = (botId) => !!get("SELECT 1 FROM reports WHERE bot_id = ? AND day = ? AND kind = 'eod'", botId, today());

// ---- Timesheets ------------------------------------------------------------------------
// Hours from each Bot's work sessions, plus what it shipped and how its work was received.
export function timesheet({ days = 7 } = {}) {
  const since = now() - days * 864e5;
  const runs = all("SELECT bot_id, created, ended FROM actions WHERE kind = 'run' AND created > ? AND ended IS NOT NULL", since);
  const usage = all('SELECT bot_id, sum(cost) AS cost, count(*) AS turns FROM usage WHERE created > ? GROUP BY bot_id', since);
  const done = all("SELECT owner_id, count(*) AS n FROM tasks WHERE status = 'done' AND done_at > ? GROUP BY owner_id", since);
  const back = all("SELECT bot_id, count(*) AS n FROM actions WHERE kind = 'task' AND status = 'error' AND created > ? GROUP BY bot_id", since);
  const drafts = all("SELECT bot_id, count(*) AS n FROM actions WHERE kind = 'draft' AND created > ? GROUP BY bot_id", since);
  const total = usage.reduce((n, u) => n + (u.cost || 0), 0) || 1;
  return chats.listBots().map((b) => {
    const mine = runs.filter((r) => r.bot_id === b.id);
    const ms = mine.reduce((n, r) => n + Math.max(0, Math.min(r.ended - r.created, 6 * 3600e3)), 0);
    const u = usage.find((x) => x.bot_id === b.id) || {};
    return { botId: b.id, hours: Math.round((ms / 3600e3) * 10) / 10, minutes: Math.round(ms / 60e3), sessions: mine.length, turns: u.turns || 0,
      share: Math.round(((u.cost || 0) / total) * 100), tasksDone: done.find((x) => x.owner_id === b.id)?.n || 0,
      sentBack: back.find((x) => x.bot_id === b.id)?.n || 0, drafts: drafts.find((x) => x.bot_id === b.id)?.n || 0 };
  });
}

// ---- What a Bot knows about its place in the company ---------------------------------------
export function promptBlock(bot) {
  const boss = bossOf(bot.id);
  const reports = reportsOf(bot.id);
  const open = tasks({ ownerId: bot.id, open: true });
  const co = companyName();
  return `## Your job${co ? ` at ${co}` : ''}
You are ${bot.title ? `the ${bot.title}` : 'an employee'}${co ? ` at ${co}` : ''}, reporting to ${boss ? `${boss.name}${boss.title ? ` (${boss.title})` : ''}` : 'Neil, the founder'}.${reports.length ? ` Your team: ${reports.map((r) => r.name).join(', ')}; you can hand them work with assign_task.` : ''}
You own your area end to end. Do the work yourself; involve teammates only when the work is truly theirs.${open.length ? `
Your open assignments:
${open.slice(0, 8).map((t) => `- ${t.title} (id ${t.id})${t.due ? `, due ${t.due}` : ''}`).join('\n')}
Mark them done with submit_task when finished.` : ''}`;
}
