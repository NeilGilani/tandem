// Squads: one job split across several helper Bots working at the same time, each on its
// own computer (a copy of the lead Bot's, so it has the same sign-ins). The lead plans the
// parts, the helpers work in parallel, and the lead is woken to check and merge the results.
import fs from 'node:fs';
import path from 'node:path';
import { db, all, get, run, uid, now, parseRow, PATHS } from './db.js';
import { emit } from './bus.js';
import * as chats from './chats.js';
import * as computer from './computer.js';
import * as activity from './activity.js';

db.exec(`
CREATE TABLE IF NOT EXISTS squads (
  id TEXT PRIMARY KEY, lead_id TEXT NOT NULL, chat_id TEXT NOT NULL, goal TEXT, merge TEXT,
  status TEXT DEFAULT 'working', parts TEXT DEFAULT '[]', dir TEXT, message_id TEXT,
  created INTEGER, updated INTEGER, finished INTEGER
);`);

export const MAX_PARTS = 8;
const PARALLEL = Number(process.env.TANDEM_SQUAD_PARALLEL) || 4;

let engine = null;
export const attach = (e) => { engine = e; };

const parse = (r) => parseRow(r, ['parts']);
export const getSquad = (id) => parse(get('SELECT * FROM squads WHERE id = ?', id));
export const list = (limit = 30) => all('SELECT * FROM squads ORDER BY created DESC LIMIT ?', limit).map(parse);

function save(s, patch = {}) {
  Object.assign(s, patch, { updated: now() });
  run('UPDATE squads SET status = ?, parts = ?, message_id = ?, updated = ?, finished = ? WHERE id = ?',
    s.status, JSON.stringify(s.parts), s.message_id, s.updated, s.finished || null, s.id);
  emit('squad', publicSquad(s));
  // Keep the card in the chat in step.
  if (s.message_id) {
    const m = chats.getMessage(s.message_id);
    if (m) chats.updateMessage(s.message_id, { card: { ...m.card, status: s.status === 'working' ? 'pending' : s.status, squad: publicSquad(s) } });
  }
}

export const publicSquad = (s) => ({
  id: s.id, leadId: s.lead_id, chatId: s.chat_id, goal: s.goal, status: s.status, dir: s.dir, created: s.created, finished: s.finished,
  parts: s.parts.map(({ n, title, botId, status, started, ended, report, file, shot }) => ({ n, title, botId, status, started, ended, report: (report || '').slice(0, 600), file, shot })),
});

const slug = (t) => String(t).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'part';

// Start a squad. parts: [{ title, task }]. Returns right away; the lead is woken when all parts end.
export async function start({ leadId, chatId, goal, parts, merge = '' }) {
  const lead = chats.getBot(leadId);
  if (!lead) throw new Error('No such Bot');
  if (lead.helper_of) throw new Error('Helpers can’t start squads. Do your part and report back.');
  parts = (parts || []).filter((p) => p && String(p.task || '').trim());
  if (parts.length < 2) throw new Error('A squad needs at least 2 parts. For a single task, just do it.');
  if (parts.length > MAX_PARTS) throw new Error(`Up to ${MAX_PARTS} parts per squad. Group the work into fewer, bigger parts.`);
  if (all("SELECT id FROM squads WHERE lead_id = ? AND status = 'working'", leadId).length) throw new Error('You already have a squad working. Wait for its results.');
  // Work happens in the lead's one-to-one chat so cards from helpers reach the user.
  const chat = chats.getChat(chatId);
  const homeChat = chat?.kind === 'dm' ? chat : chats.dmFor(leadId);

  const id = uid('sq_');
  const dir = path.join(PATHS.shared, 'squads', id);
  fs.mkdirSync(dir, { recursive: true });

  // Reuse this lead's helpers; make more if needed.
  const helpers = chats.listHelpers(leadId);
  while (helpers.length < Math.min(parts.length, PARALLEL)) helpers.push(chats.createHelper(lead, helpers.length + 1));
  const s = {
    id, lead_id: leadId, chat_id: homeChat.id, goal: String(goal || '').trim(), merge: String(merge || '').trim(), status: 'working', dir,
    parts: parts.map((p, i) => ({ n: i + 1, title: String(p.title || `Part ${i + 1}`).slice(0, 80), task: String(p.task).trim(), botId: null, status: 'queued',
      file: path.join(dir, `${i + 1}-${slug(p.title || `part ${i + 1}`)}.md`) })),
    message_id: null, created: now(),
  };
  run('INSERT INTO squads (id, lead_id, chat_id, goal, merge, status, parts, dir, created, updated) VALUES (?,?,?,?,?,?,?,?,?,?)',
    s.id, s.lead_id, s.chat_id, s.goal, s.merge, s.status, JSON.stringify(s.parts), s.dir, s.created, s.created);
  const msg = chats.addMessage({ chatId: s.chat_id, author: 'bot', botId: leadId, text: '', card: { type: 'squad', status: 'pending', squadId: id, squad: publicSquad(s) } });
  s.message_id = msg.id;
  save(s);
  activity.log({ botId: leadId, chatId: s.chat_id, kind: 'run', summary: `Squad started: ${parts.length} parts in parallel`, detail: s.goal, status: 'running', origin: 'squad' });
  if (homeChat.id !== chatId && chat) chats.addMessage({ chatId, author: 'system', botId: leadId, text: `${lead.name} is working on this with a squad in its one-to-one chat.` });

  pump(s.id, helpers.map((h) => h.id));
  return { squad: id, parts: s.parts.length, parallel: Math.min(parts.length, PARALLEL), folder: dir };
}

// Hand queued parts to free helpers until every part is done.
const pools = new Map(); // squadId -> helper ids
function pump(id, helperIds) {
  if (helperIds) pools.set(id, helperIds);
  const s = getSquad(id);
  if (!s || s.status !== 'working') return;
  const busy = new Set(s.parts.filter((p) => p.status === 'working').map((p) => p.botId));
  const free = (pools.get(id) || []).filter((h) => !busy.has(h) && chats.getBot(h));
  for (const part of s.parts.filter((p) => p.status === 'queued')) {
    const helper = free.shift();
    if (!helper) break;
    runPart(s, part, helper);
  }
  if (s.parts.every((p) => ['done', 'failed', 'stopped'].includes(p.status))) finish(s);
}

async function runPart(s, part, helperId) {
  const lead = chats.getBot(s.lead_id);
  part.botId = helperId; part.status = 'working'; part.started = now();
  save(s);
  try { await computer.cloneProfile(s.lead_id, helperId); } catch {}
  const others = s.parts.filter((p) => p.n !== part.n).map((p) => `- Part ${p.n}: ${p.title}`).join('\n');
  const brief = `[Squad part ${part.n} of ${s.parts.length}. You are helping ${lead.name}, working in parallel with other helpers.]

Overall goal: ${s.goal}

Your part: ${part.title}
${part.task}

Other parts (done by others at the same time, don't do them):
${others}

Write your complete result to ${part.file} (Markdown, with sources or links for facts). Your computer is a copy of
${lead.name}'s, with the same sign-ins. Work fast and independently: don't ask the user anything unless you're truly
blocked. Your final reply goes to ${lead.name}: two to four sentences on what you produced and anything uncertain.`;
  let res;
  try {
    res = await engine.runBot(helperId, s.chat_id, brief, { origin: 'squad', sessionKey: `squad:${s.id}:${part.n}`, squadId: s.id, depth: 1 });
  } catch (e) { res = { error: e.message }; }
  const cur = getSquad(s.id);
  if (!cur) return;
  const p = cur.parts.find((x) => x.n === part.n);
  if (p.status === 'working') {
    p.ended = now();
    p.report = res?.text || res?.error || '';
    p.shot = res?.shot || null;
    p.status = res?.error && !fs.existsSync(p.file) ? 'failed' : 'done';
    save(cur);
  }
  pump(s.id);
}

function finish(s) {
  if (s.status !== 'working') return;
  save(s, { status: 'merging' });
  const lead = chats.getBot(s.lead_id);
  const secs = Math.round((now() - s.created) / 1000);
  const parts = s.parts.map((p) => `### Part ${p.n}: ${p.title} (${p.status})
File: ${fs.existsSync(p.file) ? p.file : '(not written)'}
Helper's report: ${(p.report || '').slice(0, 1500) || '(none)'}`).join('\n\n');
  engine.runBot(s.lead_id, s.chat_id, `[Your squad finished in ${Math.floor(secs / 60)}m ${secs % 60}s. Goal: ${s.goal}]

${parts}

Now read every part file, check each against the goal (fill small gaps yourself, flag anything you can't verify), and
merge them into one finished deliverable${s.merge ? ` (${s.merge})` : ''}. Save it in ${s.dir} and add it to your Library,
then reply to the user with the result itself.`, { origin: 'system' }).then(() => {
    const cur = getSquad(s.id);
    if (cur && cur.status === 'merging') save(cur, { status: 'done', finished: now() });
  });
  activity.log({ botId: s.lead_id, chatId: s.chat_id, kind: 'run', summary: `Squad finished its ${s.parts.length} parts`, status: 'ok', origin: 'squad' });
}

export function stop(id) {
  const s = getSquad(id);
  if (!s || !['working', 'merging'].includes(s.status)) return false;
  for (const p of s.parts) {
    if (p.status === 'queued' || p.status === 'working') p.status = 'stopped';
  }
  save(s, { status: 'stopped', finished: now() });
  for (const r of engine.activeRuns()) if (r.squadId === id || (r.chatId === s.chat_id && s.parts.some((p) => p.botId === r.botId))) engine.stop(r.id);
  return true;
}

// After a restart, squads that were mid-flight can't resume their helpers' turns.
export function recover() {
  for (const s of all("SELECT * FROM squads WHERE status IN ('working', 'merging')").map(parse)) {
    for (const p of s.parts) if (p.status === 'working' || p.status === 'queued') p.status = 'stopped';
    save(s, { status: 'stopped', finished: now() });
  }
}

export const isHelper = (botId) => !!chats.getBot(botId)?.helper_of;
