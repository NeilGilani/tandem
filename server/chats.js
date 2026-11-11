// Bots, conversations (one-to-one and group chats) and messages.
import { all, get, run, uid, now, parseRow } from './db.js';
import { emit } from './bus.js';
import * as memory from './memory.js';

const COLORS = ['#6d5dfc', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#8b5cf6', '#14b8a6'];
const SHAPES = ['circle', 'squircle', 'hexagon', 'diamond', 'blob', 'star'];

// ---- Bots -----------------------------------------------------------------------
export const listBots = () => all('SELECT * FROM bots WHERE helper_of IS NULL ORDER BY is_primary DESC, pinned DESC, created');
export const listHelpers = (leadId) => leadId
  ? all('SELECT * FROM bots WHERE helper_of = ? ORDER BY created', leadId)
  : all('SELECT * FROM bots WHERE helper_of IS NOT NULL ORDER BY created');

// A squad helper: a hidden Bot that works for a lead Bot on its own computer.
export function createHelper(lead, n) {
  const id = uid('bot_');
  run(`INSERT INTO bots (id, name, label, shape, color, hidden, helper_of, notify, drafts, created) VALUES (?,?,?,?,?,1,?,0,?,?)`,
    id, `${lead.name} helper ${n}`, 'Squad helper', SHAPES[(SHAPES.indexOf(lead.shape) + n) % SHAPES.length], lead.color, lead.id, lead.drafts, now());
  emit('bots');
  return getBot(id);
}
export const getBot = (id) => get('SELECT * FROM bots WHERE id = ?', id);
export const findBot = (nameOrId) => getBot(nameOrId)
  || get('SELECT * FROM bots WHERE helper_of IS NULL AND lower(name) = lower(?)', String(nameOrId).replace(/^@/, ''));

export function createBot({ name, shape, color, label = '', template = null }) {
  if (!name?.trim()) throw new Error('A Bot needs a name');
  const id = uid('bot_');
  const count = get('SELECT count(*) AS n FROM bots').n;
  run(`INSERT INTO bots (id, name, label, shape, color, template, is_primary, created) VALUES (?,?,?,?,?,?,?,?)`,
    id, name.trim(), label, shape || SHAPES[count % SHAPES.length], color || COLORS[count % COLORS.length],
    template, count === 0 ? 1 : 0, now());
  dmFor(id);
  emit('bots');
  return getBot(id);
}

const BOT_FIELDS = ['name', 'label', 'shape', 'color', 'avatar', 'section', 'pinned', 'hidden', 'notify', 'drafts'];
export function updateBot(id, patch) {
  const before = getBot(id);
  if (patch.name && before && patch.name.trim() && patch.name.trim() !== before.name) {
    setTimeout(() => addMessage({ chatId: dmFor(id).id, author: 'system', botId: id, text: `Renamed to ${patch.name.trim()}`, meta: { kind: 'rename' } }), 0);
  }
  for (const [k, v] of Object.entries(patch)) {
    if (!BOT_FIELDS.includes(k)) continue;
    run(`UPDATE bots SET ${k} = ? WHERE id = ?`, typeof v === 'boolean' ? Number(v) : v, id);
  }
  emit('bots');
  return getBot(id);
}

export function setPrimary(id) {
  run('UPDATE bots SET is_primary = 0');
  run('UPDATE bots SET is_primary = 1 WHERE id = ?', id);
  emit('bots');
}

export function primaryBot() {
  return get('SELECT * FROM bots WHERE is_primary = 1') || get('SELECT * FROM bots ORDER BY created LIMIT 1');
}

export function deleteBot(id) {
  for (const h of all('SELECT id FROM bots WHERE helper_of = ?', id)) deleteBot(h.id);
  const chats = all('SELECT * FROM chats').map((c) => parseRow(c, ['bot_ids']));
  for (const c of chats) {
    if (!c.bot_ids.includes(id)) continue;
    if (c.kind === 'dm') {
      run('DELETE FROM messages WHERE chat_id = ?', c.id);
      run('DELETE FROM chats WHERE id = ?', c.id);
    } else {
      run('UPDATE chats SET bot_ids = ? WHERE id = ?', JSON.stringify(c.bot_ids.filter((b) => b !== id)), c.id);
    }
  }
  run('DELETE FROM chat_sessions WHERE bot_id = ?', id);
  run('DELETE FROM runs WHERE routine_id IN (SELECT id FROM routines WHERE bot_id = ?)', id);
  run('DELETE FROM routines WHERE bot_id = ?', id);
  run('DELETE FROM library WHERE bot_id = ?', id);
  run('DELETE FROM skill_disabled WHERE bot_id = ?', id);
  const wasPrimary = getBot(id)?.is_primary;
  run('DELETE FROM bots WHERE id = ?', id);
  memory.deleteBot(id);
  if (wasPrimary) { const next = get('SELECT id FROM bots ORDER BY created LIMIT 1'); if (next) setPrimary(next.id); }
  emit('bots'); emit('chats');
}

// ---- Chats ------------------------------------------------------------------------
// Each Bot's back office: a hidden chat where Bot-to-Bot work happens (handoffs, assignments,
// replies), so your chats only hold what's meant for you.
export function officeFor(botId) {
  const existing = all("SELECT * FROM chats WHERE kind = 'office'").map((c) => parseRow(c, ['bot_ids'])).find((c) => c.bot_ids[0] === botId);
  if (existing) return existing;
  const id = uid('chat_');
  run('INSERT INTO chats (id, kind, name, bot_ids, created, updated) VALUES (?,?,?,?,?,?)', id, 'office', 'Back office', JSON.stringify([botId]), now(), now());
  return getChat(id);
}

export function dmFor(botId) {
  const existing = all("SELECT * FROM chats WHERE kind = 'dm'").map((c) => parseRow(c, ['bot_ids'])).find((c) => c.bot_ids[0] === botId);
  if (existing) return existing;
  const id = uid('chat_');
  run('INSERT INTO chats (id, kind, name, bot_ids, created, updated) VALUES (?,?,?,?,?,?)', id, 'dm', null, JSON.stringify([botId]), now(), now());
  return getChat(id);
}

export function createGroup({ botIds, name }) {
  const ids = [...new Set(botIds)].filter((b) => getBot(b));
  if (ids.length < 2 || ids.length > 6) throw new Error('A group chat has two to six Bots');
  const id = uid('chat_');
  const autoName = name?.trim() || ids.map((b) => getBot(b).name).join(', ');
  run('INSERT INTO chats (id, kind, name, bot_ids, created, updated) VALUES (?,?,?,?,?,?)', id, 'group', autoName, JSON.stringify(ids), now(), now());
  emit('chats');
  return getChat(id);
}

export const getChat = (id) => parseRow(get('SELECT * FROM chats WHERE id = ?', id), ['bot_ids']);
export const listChats = () => all("SELECT * FROM chats WHERE kind != 'office' ORDER BY updated DESC").map((c) => parseRow(c, ['bot_ids']))
  .filter((c) => c.kind !== 'dm' || !getBot(c.bot_ids[0])?.helper_of);

export function updateChat(id, { name, botIds }) {
  if (name != null) run('UPDATE chats SET name = ? WHERE id = ?', name, id);
  if (botIds) {
    const c = getChat(id);
    if (c.kind !== 'group') throw new Error('Only group membership can change');
    if (botIds.length < 2 || botIds.length > 6) throw new Error('A group chat has two to six Bots');
    run('UPDATE chats SET bot_ids = ? WHERE id = ?', JSON.stringify(botIds), id);
  }
  emit('chats');
  return getChat(id);
}

export function deleteChat(id) {
  run('DELETE FROM messages WHERE chat_id = ?', id);
  run('DELETE FROM chat_sessions WHERE chat_id = ?', id);
  run('DELETE FROM chats WHERE id = ?', id);
  emit('chats');
}

// "Reset conversation" keeps memory, files, routines and settings.
export function resetChat(id) {
  run('DELETE FROM chat_sessions WHERE chat_id = ?', id);
  addMessage({ chatId: id, author: 'system', text: 'Conversation reset. Memory, files, routines and settings are kept.' });
}

export const sessionFor = (chatId, botId) => get('SELECT session_id FROM chat_sessions WHERE chat_id = ? AND bot_id = ?', chatId, botId)?.session_id;
export const setSession = (chatId, botId, sid) =>
  run('INSERT INTO chat_sessions (chat_id, bot_id, session_id) VALUES (?,?,?) ON CONFLICT(chat_id, bot_id) DO UPDATE SET session_id = excluded.session_id', chatId, botId, sid);

// ---- Messages ---------------------------------------------------------------------
const MSG_JSON = ['reactions', 'card', 'attachments', 'meta'];
export const parseMsg = (m) => parseRow(m, MSG_JSON);

let cardOwner = null;
export const setCardOwner = (fn) => { cardOwner = fn; };

export function addMessage({ chatId, author, botId = null, text = '', parentId = null, card = null, attachments = [], meta = {} }) {
  const id = uid('msg_');
  if (card && card.for === undefined && botId && cardOwner) card = { ...card, for: cardOwner(botId, chatId, card) };
  run(`INSERT INTO messages (id, chat_id, author, bot_id, text, parent_id, card, attachments, meta, created) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    id, chatId, author, botId, text, parentId, card ? JSON.stringify(card) : null, JSON.stringify(attachments), JSON.stringify(meta), now());
  run('UPDATE chats SET updated = ? WHERE id = ?', now(), chatId);
  const msg = getMessage(id);
  emit('message', msg);
  return msg;
}

export const getMessage = (id) => parseMsg(get('SELECT * FROM messages WHERE id = ?', id));

export function updateMessage(id, patch) {
  for (const [k, v] of Object.entries(patch)) {
    if (!['text', 'card', 'reactions', 'meta'].includes(k)) continue;
    run(`UPDATE messages SET ${k} = ? WHERE id = ?`, typeof v === 'string' ? v : JSON.stringify(v), id);
  }
  const msg = getMessage(id);
  emit('message', msg);
  return msg;
}

export function messages(chatId, { before, limit = 200 } = {}) {
  const rows = before
    ? all('SELECT * FROM messages WHERE chat_id = ? AND created < ? ORDER BY created DESC LIMIT ?', chatId, before, limit)
    : all('SELECT * FROM messages WHERE chat_id = ? ORDER BY created DESC LIMIT ?', chatId, limit);
  return rows.reverse().map(parseMsg);
}

export function react(id, emoji) {
  const m = getMessage(id);
  const r = m.reactions || {};
  r[emoji] = r[emoji] ? 0 : 1;
  if (!r[emoji]) delete r[emoji];
  return updateMessage(id, { reactions: r });
}

export function search(q) {
  const like = `%${q}%`;
  return {
    messages: all('SELECT * FROM messages WHERE text LIKE ? ORDER BY created DESC LIMIT 30', like).map(parseMsg),
    bots: all('SELECT * FROM bots WHERE name LIKE ? OR label LIKE ?', like, like),
    groups: all("SELECT * FROM chats WHERE kind = 'group' AND name LIKE ?", like).map((c) => parseRow(c, ['bot_ids'])),
    routines: all('SELECT * FROM routines WHERE name LIKE ? OR instruction LIKE ?', like, like),
    files: all('SELECT * FROM library WHERE title LIKE ? OR ref LIKE ?', like, like),
  };
}

// ---- Library ------------------------------------------------------------------------
export function addToLibrary({ botId, kind = 'file', title, ref, visibility = 'Private' }) {
  const id = uid('lib_');
  run('INSERT INTO library (id, bot_id, kind, title, ref, visibility, created) VALUES (?,?,?,?,?,?,?)', id, botId, kind, title || ref, ref, visibility, now());
  emit('library', { botId });
  return id;
}
export const library = (botId) => all('SELECT * FROM library WHERE bot_id = ? ORDER BY created DESC', botId);

// ---- Duplicate ----------------------------------------------------------------------
export function duplicateBot(id) {
  const b = getBot(id);
  const copy = createBot({ name: `${b.name} copy`, shape: b.shape, color: b.color, label: b.label, template: b.template });
  if (b.avatar) updateBot(copy.id, { avatar: b.avatar });
  for (const s of all('SELECT slug FROM skill_disabled WHERE bot_id = ?', id)) run('INSERT OR IGNORE INTO skill_disabled (bot_id, slug) VALUES (?,?)', copy.id, s.slug);
  for (const r of all('SELECT * FROM routines WHERE bot_id = ?', id)) {
    run(`INSERT INTO routines (id, bot_id, name, instruction, trigger, schedule_text, cron, when_text, webhook_secret, paused, next_run, created)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, uid('rt_'), copy.id, r.name, r.instruction, r.trigger, r.schedule_text, r.cron, r.when_text,
      r.webhook_secret ? uid('whsec_') : null, 1, r.next_run, now());
  }
  memory.copy(id, copy.id);
  return copy;
}
