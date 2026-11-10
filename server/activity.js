// Activity log and plan usage.
//
// Every step a Bot takes (opening a page, running a command, sending a draft, being
// denied, failing) is recorded here, so the Activity timeline can show what every Bot
// did today. Plan usage comes straight from Claude Code's rate-limit events: the real
// share of your 5-hour and weekly limits that's been used.
import { db, all, get, run, uid, now, setting, setSetting } from './db.js';
import { emit } from './bus.js';

db.exec(`
CREATE TABLE IF NOT EXISTS actions (
  id TEXT PRIMARY KEY, run_id TEXT, bot_id TEXT, chat_id TEXT, kind TEXT, tool TEXT,
  summary TEXT, detail TEXT, status TEXT, origin TEXT, created INTEGER, ended INTEGER
);
CREATE INDEX IF NOT EXISTS actions_time ON actions(created);
CREATE INDEX IF NOT EXISTS actions_bot ON actions(bot_id, created);
`);

const KEEP_DAYS = 30;

// kind: tool | approval | draft | message | handoff | error | run
export function log({ runId = null, botId = null, chatId = null, kind, tool = null, summary, detail = null, status = 'ok', origin = null }) {
  const id = uid('act_');
  run(`INSERT INTO actions (id, run_id, bot_id, chat_id, kind, tool, summary, detail, status, origin, created)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`, id, runId, botId, chatId, kind, tool, String(summary || '').slice(0, 300),
  detail ? String(detail).slice(0, 4000) : null, status, origin, now());
  emit('activity', { id, botId });
  return id;
}

export function finish(id, status, detail) {
  if (!id) return;
  run('UPDATE actions SET status = ?, ended = ?, detail = COALESCE(?, detail) WHERE id = ?', status, now(), detail ? String(detail).slice(0, 4000) : null, id);
  emit('activity', { id });
}

export function list({ botId, since, until, kind, q, limit = 300 } = {}) {
  const where = [], args = [];
  if (botId) { where.push('bot_id = ?'); args.push(botId); }
  if (since) { where.push('created >= ?'); args.push(since); }
  if (until) { where.push('created < ?'); args.push(until); }
  if (kind) { where.push('kind = ?'); args.push(kind); }
  if (q) { where.push('(summary LIKE ? OR detail LIKE ?)'); args.push(`%${q}%`, `%${q}%`); }
  return all(`SELECT * FROM actions ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created DESC LIMIT ?`, ...args, limit);
}

export function prune() {
  run('DELETE FROM actions WHERE created < ?', now() - KEEP_DAYS * 864e5);
}

// ---- Plan usage --------------------------------------------------------------------------
export function recordPlan(info) {
  if (!info) return;
  const w = info.unifiedWindows || {};
  const plan = {
    status: info.status,
    fiveHour: w.five_hour ? { used: w.five_hour.utilization, resetsAt: w.five_hour.resetsAt * 1000, status: w.five_hour.status } : null,
    week: w.seven_day ? { used: w.seven_day.utilization, resetsAt: w.seven_day.resetsAt * 1000, status: w.seven_day.status } : null,
    limitType: info.rateLimitType,
    resetsAt: info.resetsAt ? info.resetsAt * 1000 : null,
    updated: now(),
  };
  setSetting('plan_usage', JSON.stringify(plan));
  emit('usage', plan);
  return plan;
}

export function plan() {
  try { return JSON.parse(setting('plan_usage') || 'null'); } catch { return null; }
}

// Routines pause themselves when your plan is nearly used up (Settings → Usage).
export function routinesShouldWait() {
  if (setting('usage_guard') === '0') return null;
  const p = plan();
  if (!p) return null;
  const t = Number(setting('usage_guard_at') || 0.9);
  if (p.status && p.status !== 'allowed') return { reason: 'Your Claude plan limit is reached', until: p.resetsAt };
  if (p.week && p.week.used >= t) return { reason: `Your weekly Claude limit is ${Math.round(p.week.used * 100)}% used`, until: p.week.resetsAt };
  if (p.fiveHour && p.fiveHour.used >= Math.max(t, 0.95)) return { reason: `Your 5-hour Claude limit is ${Math.round(p.fiveHour.used * 100)}% used`, until: p.fiveHour.resetsAt };
  return null;
}

export const summary = () => ({
  plan: plan(),
  today: get('SELECT count(*) AS n FROM actions WHERE created > ?', now() - 864e5).n,
});
