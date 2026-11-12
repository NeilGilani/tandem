// How the company runs without Neil in the loop for everything:
// - Inbox: Bots message each other asynchronously. A message waits for the teammate's next work
//   session instead of interrupting them (unless Neil is waiting on the answer in a chat).
// - Chain of command: a Bot that's stuck asks its boss. The boss decides, or escalates to Neil
//   only for decisions that are his. The asker never waits: it moves on to other work and the
//   answer arrives in a later session.
// - Email triage: routine emails go to the writer's boss, who approves and sends them. Emails
//   that shape how people see Vitals (investors, first contact, commitments) go to Neil. Nobody
//   stops working while a draft waits.
// - Rotation: only a few Bots work at once, sized to how much of the Claude plan is left.
import { db, all, get, run, uid, now } from './db.js';
import { emit } from './bus.js';
import { quickJson } from './claude.js';
import * as chats from './chats.js';
import * as company from './company.js';
import * as activity from './activity.js';
import { ownerFirst } from './members.js';

db.exec(`CREATE TABLE IF NOT EXISTS bot_inbox (
  id TEXT PRIMARY KEY, to_bot TEXT NOT NULL, from_bot TEXT, kind TEXT, ref TEXT, text TEXT,
  status TEXT DEFAULT 'open', answer TEXT, created INTEGER, read_at INTEGER, answered_at INTEGER
);`);

let engine = null;
export const attach = (e) => { engine = e; };
const name = (id) => (id === 'user' ? ownerFirst() : chats.getBot(id)?.name || 'A teammate');

// ---- Inbox --------------------------------------------------------------------------------
export function deliver({ to, from, kind = 'message', text, ref = null }) {
  const id = uid('ib_');
  run('INSERT INTO bot_inbox (id, to_bot, from_bot, kind, ref, text, created) VALUES (?,?,?,?,?,?,?)', id, to, from, kind, ref, String(text).slice(0, 6000), now());
  emit('inbox', { to });
  wake(to);
  return id;
}

// Unread items for a Bot's next session. Marked read once handed over.
export function take(botId) {
  const items = all("SELECT * FROM bot_inbox WHERE to_bot = ? AND read_at IS NULL ORDER BY created LIMIT 30", botId);
  if (items.length) run(`UPDATE bot_inbox SET read_at = ? WHERE id IN (${items.map(() => '?').join(',')})`, now(), ...items.map((i) => i.id));
  return items;
}
export const unread = (botId) => get('SELECT count(*) AS n FROM bot_inbox WHERE to_bot = ? AND read_at IS NULL', botId).n;
export const openQuestionsFor = (botId) => all("SELECT * FROM bot_inbox WHERE to_bot = ? AND kind = 'question' AND status = 'open' ORDER BY created", botId);

export function inboxBlock(botId) {
  const items = take(botId);
  if (!items.length) return '';
  const lines = items.map((i) => {
    const who = name(i.from_bot);
    if (i.kind === 'question') return `- QUESTION ${i.id} from ${who} (your report): ${i.text}\n  Decide it now with answer_teammate (id ${i.id}). Escalate with escalate_to_neil only if it's truly ${ownerFirst()}'s call.`;
    if (i.kind === 'answer') return `- ANSWER from ${who} to your question "${(i.ref || '').slice(0, 160)}": ${i.text}`;
    if (i.kind === 'draft_back') return `- ${who} sent your draft back: ${i.text}`;
    if (i.kind === 'review') return `- DRAFT TO DECIDE (card ${i.ref}) from ${who}, your report. It's routine, so you decide and it goes out on your approval:\n${i.text.split('\n').map((l) => `    ${l}`).join('\n')}\n  Check it's true, not a duplicate (gmail_search the recipient), and reads well. Then review_draft card_id ${i.ref}: approve (sends now; fix wording if needed) or send_back with notes.`;
    return `- ${who}: ${i.text}`;
  });
  return `Your inbox (${items.length}):\n${lines.join('\n')}\n\n`;
}

// A shift Bot with new inbox items gets its next session soon. A Bot without a shift handles
// them right away in its back office.
let wakeFn = () => false;
export const onWake = (fn) => { wakeFn = fn; };
const pendingWake = new Set();
function wake(botId) {
  let handled = false;
  try { handled = wakeFn(botId); } catch {}
  if (handled || !engine || pendingWake.has(botId)) return;
  pendingWake.add(botId);
  setTimeout(() => {
    pendingWake.delete(botId);
    const block = inboxBlock(botId);
    if (block) engine.runInOffice(botId, `${block}Handle these now, briefly, then stop.`, { origin: 'handoff' }).catch(() => {});
  }, 5000);
}

// ---- Chain of command ---------------------------------------------------------------------
// Things only the owner decides. Everything else, a boss can decide.
export const OWNER_CALLS = 'spending money or committing to a price, signing or agreeing to anything, anything with investors, ' +
  'the first contact with an important person or organization, public statements, hiring, legal or safety matters, and changes to the company\'s direction';

// A Bot is stuck on a question. Route it to its boss (non-blocking), or to the owner.
export async function ask(ctx, { question, options = [] }) {
  const boss = company.bossOf(ctx.botId);
  const big = boss ? await isOwnerCall(question) : true;
  if (!big) {
    deliver({ to: boss.id, from: ctx.botId, kind: 'question', text: `${question}${options.length ? ` (options: ${options.join(' / ')})` : ''}` });
    activity.log({ botId: ctx.botId, kind: 'handoff', summary: `Asked ${boss.name}: ${question.slice(0, 100)}`, status: 'ok', origin: ctx.origin });
    return { routed: 'boss', to: boss.name };
  }
  return { routed: 'owner' };
}

async function isOwnerCall(question) {
  try {
    const j = await quickJson(`A teammate at a startup has this question: "${String(question).slice(0, 1200)}"\n\n` +
      `Only the founder decides: ${OWNER_CALLS}. Anything else (how to do the work, priorities within their lane, ` +
      'which vendor to ask, wording of routine messages, scheduling, research choices) their manager decides.\n' +
      'Reply JSON only: {"founder": true|false}', { system: 'You decide who in a company should answer a question.', timeoutMs: 25000 });
    return !!j.founder;
  } catch { return false; }
}

// The boss answers a report's question.
export function answer(bossId, id, text) {
  const q = get('SELECT * FROM bot_inbox WHERE id = ?', id);
  if (!q || q.kind !== 'question') throw new Error('No such question.');
  if (q.to_bot !== bossId) throw new Error('That question was not sent to you.');
  if (q.status !== 'open') return 'Already answered.';
  run("UPDATE bot_inbox SET status = 'answered', answer = ?, answered_at = ? WHERE id = ?", String(text).slice(0, 3000), now(), id);
  deliver({ to: q.from_bot, from: bossId, kind: 'answer', text, ref: q.text });
  activity.log({ botId: bossId, kind: 'decision', summary: `Decided for ${name(q.from_bot)}: ${q.text.slice(0, 90)}`, detail: text, status: 'ok', origin: 'company' });
  return `Answered. ${name(q.from_bot)} gets it in their next session.`;
}

// The boss decides this one is the owner's call: it becomes a card for the owner.
export function escalate(bossId, id, note, postCard) {
  const q = get('SELECT * FROM bot_inbox WHERE id = ?', id);
  if (!q || q.to_bot !== bossId) throw new Error('No such question for you.');
  run("UPDATE bot_inbox SET status = 'escalated', answered_at = ? WHERE id = ?", now(), id);
  postCard({ botId: q.from_bot, question: `${q.text}${note ? `\n\n${name(bossId)}: ${note}` : ''}` });
  return `Sent to ${ownerFirst()}. ${name(q.from_bot)} keeps working and gets the answer when it comes.`;
}

// ---- Email triage -------------------------------------------------------------------------
// 'owner' for emails where the impression matters for the company's future; 'boss' otherwise.
export async function triageEmail(botId, card) {
  const boss = company.bossOf(botId);
  if (!boss) return { route: 'owner', why: 'From the top of the company' };
  const sent = all("SELECT 1 FROM actions WHERE tool = 'gmail_send' AND summary LIKE ? LIMIT 1", `%${String(card.to || '').split(',')[0].trim()}%`).length > 0;
  try {
    const j = await quickJson(`An employee at Vitals (an early-stage startup building cameras that catch illness in cattle early) wrote this ${card.app || 'email'}.
To: ${card.to}${card.cc ? `\nCc: ${card.cc}` : ''}
Subject: ${card.subject || ''}
${card.thread ? 'This is a reply in an existing thread.\n' : ''}${sent ? 'The company has emailed this address before.\n' : 'The company has not emailed this address before.\n'}
${String(card.body || '').slice(0, 3000)}

Is this a BIG email where the impression matters for Vitals' future, so the founder should approve it? BIG means: investors or
fundraising; the first contact with a customer (ranch), partner, university, grant officer, journalist or anyone influential;
anything that commits Vitals to a price, date, deliverable or agreement; anything apologetic or sensitive; anything public.
ROUTINE means: supplier quote requests and follow-ups, logistics and scheduling, replies in an ongoing thread that commit to
nothing new, thank-yous, and internal notes. Their manager can approve routine ones.
Reply JSON only: {"big": true|false, "why": "under 12 words"}`, { system: 'You triage outgoing company email by stakes.', timeoutMs: 30000 });
    return { route: j.big ? 'owner' : 'boss', why: String(j.why || '').slice(0, 120), boss };
  } catch { return { route: 'owner', why: 'Could not check it, so it goes to you' }; }
}

// ---- Rotation -----------------------------------------------------------------------------
// How many Bots may work at once, from how much of the 5-hour Claude limit is used.
// The weekly limit caps it too, so the team doesn't burn the week by Wednesday.
export function slots() {
  const p = activity.plan();
  if (p?.status && !/^allowed/.test(p.status)) return 0;
  const five = p?.fiveHour?.used ?? 0, week = p?.week?.used ?? 0;
  let n = five < 0.5 ? 3 : five < 0.75 ? 2 : five < 0.92 ? 1 : 0;
  if (week >= 0.7) n = Math.min(n, week < 0.85 ? 2 : 1);
  return n;
}

// Who goes next: bosses with questions waiting (they unblock others), then whoever has worked
// least today, then rank (closest to the top first).
export function priority(m) {
  const qs = openQuestionsFor(m.bot_id).length;
  const depth = (() => { let d = 0, b = chats.getBot(m.bot_id); while (b?.boss_id && d < 6) { b = chats.getBot(b.boss_id); d++; } return d; })();
  return [-(qs > 0 ? 1 : 0), -(unread(m.bot_id) > 0 ? 1 : 0), m.sessions_today || 0, depth];
}
