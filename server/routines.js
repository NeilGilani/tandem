// Routines: a Bot runs a workflow on a schedule or when a webhook is called.
// Limits match Grok Bot: 50 routines per Bot, 20 run records per routine, schedules
// at least five minutes apart, 300 runs/hour in total and 200/hour per routine.
// A new routine waits for its next scheduled time; use Test to run it now.
import crypto from 'node:crypto';
import { all, get, run, uid, now, timezone } from './db.js';
import * as cron from './cron.js';
import { quickJson } from './claude.js';
import { emit } from './bus.js';
import * as activity from './activity.js';
import { setting } from './db.js';

const MAX_PER_BOT = 50;
const KEEP_RUNS = 20;
const RATE_TOTAL = 300, RATE_EACH = 200;
let engine = null; // set by index.js to avoid an import cycle
export const attach = (e) => { engine = e; };

export const list = (botId) => all('SELECT * FROM routines WHERE bot_id = ? ORDER BY created', botId);
export const getRoutine = (id) => get('SELECT * FROM routines WHERE id = ?', id);
export const runsOf = (id) => all('SELECT * FROM runs WHERE routine_id = ? ORDER BY started DESC LIMIT ?', id, KEEP_RUNS);

// Turn plain language ("weekdays at 8am", "every 3 hours") into cron + a restatement.
export async function interpret(text) {
  const tz = timezone();
  const j = await quickJson(
    `Convert this schedule into a 5-field cron expression (minute hour day-of-month month day-of-week), in local time zone ${tz}.\n` +
    `Schedule: "${text}"\nReply with JSON only: {"cron":"...","when":"plain restatement, e.g. Weekdays at 8:00 AM (${tz})"}`,
    { system: 'You convert natural-language schedules to standard cron. Never output schedules more frequent than every 5 minutes.' });
  cron.parse(j.cron);
  return { cron: j.cron.trim(), when: j.when };
}

export async function create({ botId, name, instruction, schedule, trigger = 'schedule' }) {
  if (list(botId).length >= MAX_PER_BOT) throw new Error('A Bot can own up to 50 routines');
  if (!instruction) throw new Error('A routine needs an instruction');
  const id = uid('rt_');
  let c = null, when = null, nextRun = null, secret = null;
  if (trigger === 'webhook') {
    secret = 'whsec_' + crypto.randomBytes(18).toString('hex');
    when = 'When the webhook is called';
  } else {
    ({ cron: c, when } = await interpret(schedule));
    if (!cron.minGapOk(c, timezone())) throw new Error('Schedules must be at least five minutes apart');
    nextRun = cron.next(c, timezone());
  }
  run(`INSERT INTO routines (id, bot_id, name, instruction, trigger, schedule_text, cron, when_text, webhook_secret, paused, next_run, created)
    VALUES (?,?,?,?,?,?,?,?,?,0,?,?)`, id, botId, name || instruction.slice(0, 48), instruction, trigger, schedule || null, c, when, secret, nextRun, now());
  emit('routines', { botId });
  return getRoutine(id);
}

export async function update(id, patch) {
  const r = getRoutine(id);
  if (!r) throw new Error('No such routine');
  if (patch.name != null) run('UPDATE routines SET name = ? WHERE id = ?', patch.name, id);
  if (patch.instruction != null) run('UPDATE routines SET instruction = ? WHERE id = ?', patch.instruction, id);
  if (patch.schedule != null && r.trigger === 'schedule') {
    const { cron: c, when } = await interpret(patch.schedule);
    if (!cron.minGapOk(c, timezone())) throw new Error('Schedules must be at least five minutes apart');
    run('UPDATE routines SET schedule_text = ?, cron = ?, when_text = ?, next_run = ? WHERE id = ?', patch.schedule, c, when, cron.next(c, timezone()), id);
  }
  if (patch.paused != null) {
    run('UPDATE routines SET paused = ? WHERE id = ?', patch.paused ? 1 : 0, id);
    if (!patch.paused && r.cron) run('UPDATE routines SET next_run = ? WHERE id = ?', cron.next(r.cron, timezone()), id);
  }
  emit('routines', { botId: r.bot_id });
  return getRoutine(id);
}

export function remove(id) {
  const r = getRoutine(id);
  run('DELETE FROM runs WHERE routine_id = ?', id);
  run('DELETE FROM routines WHERE id = ?', id);
  if (r) emit('routines', { botId: r.bot_id });
}

function rateOk(id) {
  const hourAgo = now() - 3600_000;
  if (get('SELECT count(*) AS n FROM runs WHERE started > ?', hourAgo).n >= RATE_TOTAL) return false;
  return get('SELECT count(*) AS n FROM runs WHERE routine_id = ? AND started > ?', id, hourAgo).n < RATE_EACH;
}

export function start(id, { test = false, payload = null } = {}) {
  const r = getRoutine(id);
  if (!r) throw new Error('No such routine');
  const runId = uid('run_');
  if (!rateOk(id)) {
    run('INSERT INTO runs (id, routine_id, status, reason, started, ended) VALUES (?,?,?,?,?,?)', runId, id, 'Failed', 'Automation run rate limit exceeded', now(), now());
    trim(id);
    emit('routines', { botId: r.bot_id });
    return { ok: false, reason: 'Automation run rate limit exceeded' };
  }
  run('INSERT INTO runs (id, routine_id, status, started) VALUES (?,?,?,?)', runId, id, 'Running', now());
  trim(id);
  emit('routines', { botId: r.bot_id });
  const text = `Routine "${r.name}"${test ? ' (test run)' : ''}: ${r.instruction}` +
    (payload ? `\n\nWebhook payload:\n${JSON.stringify(payload, null, 2).slice(0, 8000)}` : '') +
    '\n\nThis is unattended background work. Use current data only; if a source is missing or stale, say so instead of reusing old data. ' +
    'Draft outgoing messages instead of sending them. Report partial completion explicitly.';
  engine.runInDm(r.bot_id, text, { origin: 'routine', routineId: id, model: setting('routine_model') === 'economy' ? 'haiku' : undefined })
    .then((res) => finish(runId, res?.error ? 'Failed' : 'Succeeded', res?.error || null))
    .catch((e) => finish(runId, 'Failed', e.message));
  return { ok: true, runId };
}

function finish(runId, status, reason) {
  run('UPDATE runs SET status = ?, reason = ?, ended = ? WHERE id = ?', status, reason, now(), runId);
  const r = get('SELECT r.bot_id FROM runs x JOIN routines r ON r.id = x.routine_id WHERE x.id = ?', runId);
  if (r) emit('routines', { botId: r.bot_id });
}

function trim(id) {
  const keep = all('SELECT id FROM runs WHERE routine_id = ? ORDER BY started DESC LIMIT ?', id, KEEP_RUNS).map((x) => x.id);
  if (keep.length) run(`DELETE FROM runs WHERE routine_id = ? AND id NOT IN (${keep.map(() => '?').join(',')})`, id, ...keep);
}

export function webhook(id, authHeader, payload) {
  const r = getRoutine(id);
  if (!r || r.trigger !== 'webhook') return { status: 404, body: 'No such webhook' };
  const expected = `Bearer ${r.webhook_secret}`;
  const a = Buffer.from(String(authHeader || '')), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { status: 401, body: 'Bad key' };
  if (r.paused) return { status: 409, body: 'Routine is paused' };
  const res = start(id, { payload });
  return res.ok ? { status: 200, body: 'Run started' } : { status: 429, body: res.reason };
}

export function rotateSecret(id) {
  run('UPDATE routines SET webhook_secret = ? WHERE id = ?', 'whsec_' + crypto.randomBytes(18).toString('hex'), id);
  return getRoutine(id);
}

// Scheduler tick.
let guardNotified = 0;
// A run still marked Running at startup was cut off when Tandem last quit.
export function recover() {
  run("UPDATE runs SET status = 'Interrupted', reason = 'Tandem restarted during the run', ended = ? WHERE status = 'Running'", now());
}

export function tick() {
  const due = all("SELECT * FROM routines WHERE trigger = 'schedule' AND paused = 0 AND next_run IS NOT NULL AND next_run <= ?", now());
  if (!due.length) return;
  const wait = activity.routinesShouldWait();
  for (const r of due) {
    run('UPDATE routines SET next_run = ? WHERE id = ?', cron.next(r.cron, timezone()), r.id);
    if (wait) {
      const runId = uid('run_');
      run('INSERT INTO runs (id, routine_id, status, reason, started, ended) VALUES (?,?,?,?,?,?)', runId, r.id, 'Skipped', `${wait.reason}. Skipped to save your plan.`, now(), now());
      trim(r.id);
      emit('routines', { botId: r.bot_id });
      continue;
    }
    try { start(r.id); } catch (e) { console.error('routine', r.id, e.message); }
  }
  if (wait && now() - guardNotified > 6 * 3600e3) {
    guardNotified = now();
    emit('notify', { title: 'Routines paused', body: `${wait.reason}. Scheduled routines are skipped until it resets.` });
  }
}

export function recomputeAll() {
  for (const r of all("SELECT * FROM routines WHERE trigger = 'schedule' AND cron IS NOT NULL")) {
    run('UPDATE routines SET next_run = ? WHERE id = ?', cron.next(r.cron, timezone()), r.id);
  }
}
