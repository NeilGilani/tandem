// Missions: long-running work a Bot owns until it's done, the way a person with a
// laptop would. A mission has a goal, a "done when", a plan (a Markdown checklist the
// Bot keeps up to date) and notes. The Bot works in sessions. At the end of each one
// it checkpoints: keep going, wait until a time (e.g. "check for replies tomorrow at
// 9"), or block because it needs you. Tandem wakes it on schedule, across restarts,
// starts a fresh conversation every few sessions (the plan and notes carry over),
// respects working hours and a daily session budget, and pauses when your Claude
// plan runs low.
import { db, all, get, run, uid, now, timezone } from './db.js';
import { emit } from './bus.js';
import * as chats from './chats.js';
import * as activity from './activity.js';
import * as company from './company.js';

db.exec(`
CREATE TABLE IF NOT EXISTS missions (
  id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, chat_id TEXT NOT NULL, title TEXT, goal TEXT, done_when TEXT,
  status TEXT DEFAULT 'active', plan TEXT DEFAULT '', notes TEXT DEFAULT '[]',
  next_wake INTEGER, wake_reason TEXT, block_reason TEXT, summary TEXT,
  sessions INTEGER DEFAULT 0, sessions_today INTEGER DEFAULT 0, day TEXT,
  daily_budget INTEGER DEFAULT 12, hours TEXT DEFAULT 'any', session_key TEXT,
  created INTEGER, updated INTEGER, finished INTEGER
);
`);

const FRESH_EVERY = 6; // sessions per conversation before starting fresh from plan + notes
const CONTINUE_DELAY = 20e3;
let engine = null;
export const attach = (e) => { engine = e; };

const parse = (m) => m && { ...m, notes: JSON.parse(m.notes || '[]') };
export const getMission = (id) => parse(get('SELECT * FROM missions WHERE id = ?', id));
export const list = (botId) => all(`SELECT * FROM missions ${botId ? 'WHERE bot_id = ?' : ''} ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'blocked' THEN 1 WHEN 'waiting' THEN 2 WHEN 'paused' THEN 3 ELSE 4 END, updated DESC`, ...(botId ? [botId] : [])).map(parse);
export const activeFor = (botId) => parse(get("SELECT * FROM missions WHERE bot_id = ? AND status IN ('active','waiting','blocked') ORDER BY updated DESC LIMIT 1", botId));

function save(id, patch) {
  const cols = Object.keys(patch);
  if (!cols.length) return;
  run(`UPDATE missions SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated = ? WHERE id = ?`,
    ...cols.map((c) => (c === 'notes' ? JSON.stringify(patch[c]) : patch[c])), now(), id);
  const m = getMission(id);
  emit('mission', m);
  return m;
}

function progress(plan) {
  const done = (plan.match(/^\s*[-*] \[x\]/gim) || []).length;
  const total = done + (plan.match(/^\s*[-*] \[ \]/gm) || []).length;
  return { done, total };
}

// ---- Lifecycle ---------------------------------------------------------------------------
export function create({ botId, title, goal, doneWhen = '', hours = 'any', dailyBudget = 12, start = true }) {
  if (!goal?.trim()) throw new Error('A mission needs a goal');
  const bot = chats.getBot(botId);
  if (!bot) throw new Error('No such Bot');
  const existing = activeFor(botId);
  if (existing) throw new Error(`${bot.name} is already on a mission: "${existing.title}". Finish or pause it first.`);
  const id = uid('mis_');
  const chat = chats.dmFor(botId);
  run(`INSERT INTO missions (id, bot_id, chat_id, title, goal, done_when, status, hours, daily_budget, next_wake, session_key, created, updated)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, botId, chat.id, (title || goal).trim().slice(0, 90), goal.trim(), doneWhen.trim(),
  'active', hours, Math.max(1, Math.min(Number(dailyBudget) || 12, 200)), start ? now() + 1500 : null, `mission:${id}:1`, now(), now());
  chats.addMessage({ chatId: chat.id, author: 'system', botId, text: `Mission started: ${(title || goal).slice(0, 90)}`, meta: { kind: 'mission', missionId: id } });
  activity.log({ botId, chatId: chat.id, kind: 'run', summary: `Mission started: ${(title || goal).slice(0, 90)}`, status: 'ok', origin: 'mission' });
  const m = getMission(id);
  emit('mission', m);
  return m;
}

export function pause(id) {
  const m = save(id, { status: 'paused', next_wake: null });
  const r = engine.activeRuns().find((x) => x.botId === m.bot_id && x.origin === 'mission');
  if (r) engine.stop(r.id, { silent: true });
  chats.addMessage({ chatId: m.chat_id, author: 'system', botId: m.bot_id, text: 'Mission paused', meta: { kind: 'mission', missionId: id } });
  return m;
}
export function resume(id) {
  const m = getMission(id);
  if (activeFor(m.bot_id) && activeFor(m.bot_id).id !== id) throw new Error('This Bot already has another mission running');
  chats.addMessage({ chatId: m.chat_id, author: 'system', botId: m.bot_id, text: 'Mission resumed', meta: { kind: 'mission', missionId: id } });
  return save(id, { status: 'active', next_wake: now() + 1000, block_reason: null });
}
export function stop(id) {
  const m = save(id, { status: 'stopped', next_wake: null, finished: now() });
  const r = engine.activeRuns().find((x) => x.botId === m.bot_id && x.origin === 'mission');
  if (r) engine.stop(r.id, { silent: true });
  chats.addMessage({ chatId: m.chat_id, author: 'system', botId: m.bot_id, text: 'Mission stopped', meta: { kind: 'mission', missionId: id } });
  return m;
}
export function remove(id) { run('DELETE FROM missions WHERE id = ?', id); emit('mission', { id, deleted: true }); }
export function update(id, patch) {
  const allowed = {};
  for (const k of ['title', 'goal', 'done_when', 'hours', 'daily_budget']) if (patch[k] != null) allowed[k] = patch[k];
  return save(id, allowed);
}

// ---- Tools the Bot uses (via tools.js) ------------------------------------------------------
export function setPlan(botId, plan) {
  const m = activeFor(botId);
  if (!m) throw new Error('You are not on a mission. Use start_mission first.');
  save(m.id, { plan: String(plan).slice(0, 20000) });
  const p = progress(plan);
  return { saved: true, progress: `${p.done}/${p.total} done` };
}

// next: 'continue' | 'wait' | 'blocked' | 'done'
export function checkpoint(botId, { note, next = 'continue', wait_until, wait_reason, blocked_reason, summary }) {
  const m = activeFor(botId);
  if (!m) throw new Error('You are not on a mission.');
  const notes = [...m.notes, { at: now(), session: m.sessions, text: String(note || '').slice(0, 2000), next }].slice(-60);
  if (next === 'done') {
    save(m.id, { notes, status: 'done', summary: String(summary || note || '').slice(0, 4000), next_wake: null, finished: now() });
    chats.addMessage({ chatId: m.chat_id, author: 'system', botId, text: `Mission complete: ${m.title}`, meta: { kind: 'mission', missionId: m.id, done: true } });
    emit('notify', { botId, chatId: m.chat_id, title: `${chats.getBot(botId)?.name}: mission complete`, body: m.title });
    activity.log({ botId, chatId: m.chat_id, kind: 'run', summary: `Mission complete: ${m.title}`, detail: summary || note, status: 'ok', origin: 'mission' });
    return { recorded: true, status: 'done' };
  }
  if (next === 'blocked') {
    save(m.id, { notes, status: 'blocked', block_reason: String(blocked_reason || note || 'Needs you').slice(0, 600), next_wake: null });
    emit('notify', { botId, chatId: m.chat_id, title: `${chats.getBot(botId)?.name} needs you`, body: blocked_reason || note });
    return { recorded: true, status: 'blocked', note: 'The user is notified. Your mission resumes when they reply or press Resume.' };
  }
  if (next === 'wait') {
    let t = wait_until ? Date.parse(wait_until) : NaN;
    if (Number.isNaN(t)) t = now() + 60 * 60e3;
    t = Math.max(t, now() + 60e3);
    save(m.id, { notes, status: 'waiting', next_wake: t, wake_reason: String(wait_reason || note || '').slice(0, 300) });
    return { recorded: true, status: 'waiting', wakes: new Date(t).toLocaleString('en-US', { timeZone: timezone() }) };
  }
  save(m.id, { notes, status: 'active', next_wake: null });
  return { recorded: true, status: 'continuing', note: 'End this session now with a one-line update; the next session starts shortly.' };
}

// ---- Sessions --------------------------------------------------------------------------------
function hourParts(t, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', weekday: 'short', hour: 'numeric' }).formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return { hour: Number(p.hour), wd: p.weekday };
}
// Working hours: "any", "weekdays 9-18" or "daily 8-22". Returns when the next window opens.
function inHours(m) {
  if (!m.hours || m.hours === 'any') return { ok: true };
  const mm = String(m.hours).match(/(weekdays|daily)\s+(\d{1,2})-(\d{1,2})/);
  if (!mm) return { ok: true };
  const tz = timezone(), start = Number(mm[2]), end = Number(mm[3]);
  const open = (t) => { const p = hourParts(t, tz); return (mm[1] === 'daily' || !['Sat', 'Sun'].includes(p.wd)) && p.hour >= start && p.hour < end; };
  if (open(now())) return { ok: true };
  // Walk forward hour by hour (at most 8 days) to the start of the next window.
  let t = Math.ceil(now() / 3600e3) * 3600e3;
  for (let i = 0; i < 24 * 8 && !open(t); i++) t += 3600e3;
  return { ok: false, retry: t + 30e3 };
}

// Shift rituals: a standup to open the day, an end-of-day report to close it.
function shiftNote(m) {
  const out = [];
  if (!company.hadStandup(m.bot_id)) out.push('Start of your shift: before anything else, post_report a standup (yesterday, today, blockers).');
  const mm = String(m.hours || '').match(/(\d{1,2})-(\d{1,2})/);
  const hour = Number(new Date().toLocaleString('en-US', { timeZone: timezone(), hour: 'numeric', hourCycle: 'h23' }));
  if (mm && hour >= Number(mm[2]) - 1 && !company.hadEod(m.bot_id)) out.push('Your shift ends within the hour: finish with an end-of-day post_report (shipped, open, blocked) before your checkpoint.');
  return out.length ? out.join('\n') + '\n\n' : '';
}

function brief(m, { fresh }) {
  const p = progress(m.plan || '');
  const recent = m.notes.slice(-6).map((n) => `- ${new Date(n.at).toLocaleString('en-US', { timeZone: timezone(), dateStyle: 'medium', timeStyle: 'short' })}: ${n.text}`).join('\n') || '- (none yet)';
  return `[Mission work session ${m.sessions}${fresh ? ' — fresh conversation; your plan and notes below are your memory of this mission' : ''}]
Mission: ${m.title}
Goal: ${m.goal}
Done when: ${m.done_when || '(decide sensible done criteria, write them into your plan, and stick to them)'}
${m.wake_reason ? `You scheduled this session to: ${m.wake_reason}\n` : ''}${m.block_reason ? `You were blocked on: ${m.block_reason} (check whether the user has answered in this chat)\n` : ''}
Plan (${p.done}/${p.total} done):
${m.plan || '(no plan yet: write one with set_mission_plan as a Markdown checklist before starting)'}

Recent notes:
${recent}

${shiftNote(m)}Work on the next unchecked items for as long as it's useful in this session. Keep the plan current with set_mission_plan
(check items off as you finish them). Then call mission_checkpoint exactly once with what you did and what's next:
next="continue" to keep going right away, next="wait" with wait_until (ISO time) when you're waiting on the world
(replies, a deadline, office hours), next="blocked" when you need the user, or next="done" with a summary when the
done criteria are met and verified. End the session with one short line for the user.`;
}

export function isBusy(botId) { return engine.activeRuns().some((r) => r.botId === botId); }

export async function runSession(m) {
  if (isBusy(m.bot_id)) return save(m.id, { next_wake: now() + 60e3 });
  const wait = activity.routinesShouldWait();
  if (wait) return save(m.id, { status: 'waiting', next_wake: wait.until || now() + 30 * 60e3, wake_reason: `${wait.reason}. Resumes when it resets.` });
  const hours = inHours(m);
  if (!hours.ok) return save(m.id, { status: 'waiting', next_wake: hours.retry, wake_reason: 'Waiting for working hours' });
  const today = new Date().toLocaleDateString('en-CA', { timeZone: timezone() });
  const sessionsToday = m.day === today ? m.sessions_today : 0;
  if (sessionsToday >= m.daily_budget) {
    const t = new Date(); t.setDate(t.getDate() + 1); t.setHours(8, 0, 0, 0);
    return save(m.id, { status: 'waiting', next_wake: t.getTime(), wake_reason: `Used today's ${m.daily_budget} sessions. Continues tomorrow.`, day: today, sessions_today: sessionsToday });
  }
  // Start a fresh conversation every few sessions; the plan and notes carry the context.
  const n = m.sessions + 1;
  const fresh = n > 1 && (n - 1) % FRESH_EVERY === 0;
  const key = fresh ? `mission:${m.id}:${Math.floor((n - 1) / FRESH_EVERY) + 1}` : (m.session_key || `mission:${m.id}:1`);
  save(m.id, { status: 'active', next_wake: null, sessions: n, sessions_today: sessionsToday + 1, day: today, session_key: key, wake_reason: null });
  const cur = getMission(m.id);
  const res = await engine.runBot(m.bot_id, m.chat_id, brief(cur, { fresh }), { origin: 'mission', missionId: m.id, sessionKey: key });
  afterSession(m.id, res);
}

function afterSession(id, res) {
  const m = getMission(id);
  if (!m || !['active'].includes(m.status)) return; // done/blocked/waiting/paused were set by the Bot or you
  const last = m.notes.at(-1);
  const checkpointed = last && last.session === m.sessions;
  if (res?.error) {
    // The engine already retries transient errors; wait a bit before the next session.
    return save(id, { next_wake: now() + 10 * 60e3, wake_reason: 'Recovering from an error' });
  }
  // Keep going (the Bot asked to continue, or ended without a checkpoint).
  save(id, { next_wake: now() + (checkpointed ? CONTINUE_DELAY : CONTINUE_DELAY * 3) });
}

// When you reply in the chat while a mission is blocked, it picks back up.
export function onUserMessage(chatId, botId) {
  const m = activeFor(botId);
  if (m && m.status === 'blocked' && m.chat_id === chatId) save(m.id, { status: 'active', block_reason: null, next_wake: now() + 30e3 });
}

export function tick() {
  for (const m of all("SELECT * FROM missions WHERE status IN ('active','waiting') AND next_wake IS NOT NULL AND next_wake <= ?", now()).map(parse)) {
    runSession(m).catch((e) => { console.error('mission', m.id, e.message); save(m.id, { next_wake: now() + 5 * 60e3 }); });
  }
}

// Missions due while the Mac was off or asleep run shortly after Tandem starts.
export function recover() {
  run("UPDATE missions SET next_wake = ? WHERE status = 'active' AND (next_wake IS NULL OR next_wake < ?)", now() + 15e3, now());
}

export function promptBlock(botId) {
  const m = activeFor(botId);
  if (!m) return '';
  const p = progress(m.plan || '');
  return `\n## Your current mission\n"${m.title}" (${m.status}, ${p.done}/${p.total} plan items done, ${m.sessions} sessions so far). Goal: ${m.goal}\n` +
    'If the user messages you in between sessions, answer them; the mission continues on its own afterwards.';
}

// Whether anything will need the Mac awake soon (for keep-awake).
export const needsAwake = () => !!get("SELECT 1 FROM missions WHERE status IN ('active','waiting') AND (next_wake IS NULL OR next_wake < ?) LIMIT 1", now() + 30 * 60e3);
