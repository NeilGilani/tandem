// One line to the whole company. You say what you want; Tandem picks the Bot that owns it
// (or the chief of staff when it spans teams), it starts right away in that Bot's back
// office, and the result comes back as one line in the feed. Questions for you come back as
// one-tap decisions. You never have to open a Bot's chat.
import { all, get, run, now, timezone } from './db.js';
import { quickJson, quick } from './claude.js';
import { emit } from './bus.js';
import * as chats from './chats.js';
import * as memory from './memory.js';
import * as company from './company.js';
import * as missions from './missions.js';

let engine = null;
export const attach = (e) => { engine = e; };

// Who owns this? One Bot normally; the chief of staff for work across several areas.
async function route(text) {
  const bots = chats.listBots();
  if (!bots.length) throw new Error('Create a Bot first');
  if (bots.length === 1) return { owner: bots[0], title: text.slice(0, 80) };
  const roster = bots.map((b) => {
    const facts = memory.recall(b.id).bot.facts.slice(0, 4).map((f) => f.text.slice(0, 160)).join(' / ');
    return `- ${b.name}${b.title ? ` (${b.title})` : ''}: ${facts || 'no job notes'}`;
  }).join('\n');
  const chief = bots.find((b) => /chief/i.test(b.title || '')) || bots.find((b) => !b.boss_id && company.reportsOf(b.id).length) || bots[0];
  try {
    const j = await quickJson(`Team:\n${roster}\n\nThe founder's request: "${text}"\n\n` +
      `Pick the ONE teammate who owns this. If it clearly needs several teams, pick ${chief.name}, who coordinates. ` +
      'Also write a short title for it (max 8 words, imperative). Reply JSON only: {"owner":"Name","title":"..."}',
    { system: 'You route work to the right person on a small team.', timeoutMs: 30000 });
    const owner = bots.find((b) => b.name.toLowerCase() === String(j.owner || '').toLowerCase()) || chief;
    return { owner, title: String(j.title || text).slice(0, 80) };
  } catch { return { owner: chief, title: text.slice(0, 80) }; }
}

export async function ask(text) {
  text = String(text || '').trim();
  if (!text) throw new Error('Say what you want done');
  const { owner, title } = await route(text);
  const t = company.assign({ title, detail: text, ownerId: owner.id, assignedBy: 'user', wake: false });
  run("UPDATE tasks SET status = 'doing' WHERE id = ?", t.id);
  emit('company');
  engine.runInOffice(owner.id, `[Request from Neil, the founder] ${text}

Do it now. When it's finished, call submit_task with id ${t.id} and a ONE-LINE result (under 140 characters) that says what
happened and the number or link that matters, like "Sent 3 intros; Farmhand replied" or "Shortlist ready: 15 sites, top 3 have power".
If you need Neil's decision, use ask_user with 2 to 4 short options (one tap each). Don't explain your process anywhere.`,
  { origin: 'handoff', taskId: t.id }).catch(() => {});
  return { id: t.id, title, owner: owner.name, ownerId: owner.id };
}

// A request whose Bot finished without reporting: close it with a one-line result.
export async function closeIfOpen(taskId, text) {
  const t = company.getTask(taskId);
  if (!t || t.status === 'done') return;
  let line = String(text || '').trim();
  if (line.length > 160) line = (await quick(`Summarize in one line under 140 characters, saying what was done and the key number, name or link. No preamble.\n\n${line.slice(0, 4000)}`, { timeoutMs: 20000 }).catch(() => line.slice(0, 140))).trim();
  run("UPDATE tasks SET status = 'done', result = ?, done_at = ?, updated = ? WHERE id = ?", line || 'Done.', now(), now(), taskId);
  emit('company');
}

// The feed: what's being worked on, what's finished, and today's brief.
export function feed() {
  const runs = engine.activeRuns();
  const dayStart = new Date(new Date().toLocaleString('en-US', { timeZone: timezone() })).setHours(0, 0, 0, 0) - 0;
  const since = Math.min(dayStart, now() - 18 * 3600e3);
  const name = (id) => chats.getBot(id)?.name || 'A Bot';
  const working = company.tasks({ open: true }).filter((t) => t.assigned_by === 'user').map((t) => {
    const r = runs.find((x) => x.botId === t.owner_id);
    return { kind: 'task', id: t.id, title: t.title, botId: t.owner_id, bot: name(t.owner_id), line: r ? r.status : t.status === 'blocked' ? 'Blocked' : 'Queued', live: !!r, created: t.created };
  });
  for (const m of missions.list().filter((x) => ['active', 'waiting', 'blocked'].includes(x.status))) {
    const r = runs.find((x) => x.botId === m.bot_id && x.origin === 'mission');
    const last = (m.notes || []).at(-1);
    working.push({ kind: 'mission', id: m.id, title: m.title, botId: m.bot_id, bot: name(m.bot_id), live: !!r,
      line: r ? r.status : m.status === 'blocked' ? `Needs you: ${m.block_reason || 'a decision'}` : last ? last.text.split(/(?<=\.)\s/)[0].slice(0, 140) : 'Planning' });
  }
  const done = all("SELECT * FROM tasks WHERE status = 'done' AND done_at > ? ORDER BY done_at DESC LIMIT 30", since)
    .map((t) => ({ kind: 'task', id: t.id, title: t.title, result: (t.result || '').split('\n')[0].slice(0, 200), botId: t.owner_id, bot: name(t.owner_id), at: t.done_at }));
  const sent = all("SELECT bot_id, summary, created FROM actions WHERE tool = 'gmail_send' AND created > ? ORDER BY created DESC LIMIT 20", since)
    .map((a) => ({ kind: 'sent', title: a.summary, botId: a.bot_id, bot: name(a.bot_id), at: a.created }));
  const chief = chats.listBots().find((b) => /chief/i.test(b.title || ''));
  const brief = chief ? get("SELECT text, created FROM messages WHERE bot_id = ? AND author = 'bot' AND text != '' AND meta LIKE '%\"origin\":\"routine\"%' AND created > ? ORDER BY created DESC LIMIT 1",
    chief.id, now() - 20 * 3600e3) : null;
  return { working, done: [...done, ...sent].sort((a, b) => b.at - a.at).slice(0, 30), brief: brief ? { text: brief.text, at: brief.created, bot: chief.name } : null };
}
