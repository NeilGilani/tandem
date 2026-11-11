// App state shared by every view, kept fresh by server-sent events.
import { api } from './lib.js';

export const S = {
  bots: [], chats: [], sections: [], runs: [], connectors: [], settings: {}, computers: {},
  messages: {}, // chatId -> [messages]
  showComputer: (() => { try { return localStorage.getItem('tandem.computer') === '1'; } catch { return false; } })(),
  route: routeFromHash(),
  pending: [],
  missions: [],
  helpers: [], squads: [], ready: {},
  native: /[?&]app=mac\b/.test(location.search) || !!window.webkit?.messageHandlers?.tandem,
};

function routeFromHash() {
  const [name, id, sub] = location.hash.replace(/^#\/?/, '').split('/');
  return name ? { name, id, sub } : { name: 'home' };
}

const NEEDS_YOU = new Set(['approval', 'draft', 'question', 'secret', 'connect', 'takeover', 'skill_draft', 'hire', 'gmail_connect']);
const listeners = new Map();
export function on(evt, fn) { (listeners.get(evt) || listeners.set(evt, new Set()).get(evt)).add(fn); }
export function fire(evt, data) { for (const fn of listeners.get(evt) || []) fn(data); }

export async function refresh() {
  const st = await api('GET', '/api/state');
  Object.assign(S, st);
  fire('state');
}

export const bot = (id) => S.bots.find((b) => b.id === id) || (S.helpers || []).find((b) => b.id === id);
export const chat = (id) => S.chats.find((c) => c.id === id);
export const dmOf = (botId) => S.chats.find((c) => c.kind === 'dm' && c.bot_ids[0] === botId);
export const runsIn = (chatId) => S.runs.filter((r) => r.chatId === chatId && !r.squadId); // squad helpers show in their squad card
// Instant start: wake a Bot's computer and session while you type to it (at most every 50s).
const warmed = {};
export function warmChat(chatId, text = '') {
  const c = chat(chatId);
  if (!c || c.kind !== 'dm' || String(text).trim().length < 2 || String(text).startsWith('/')) return;
  if (Date.now() - (warmed[chatId] || 0) < 50e3 || S.runs.some((r) => r.chatId === chatId)) return;
  warmed[chatId] = Date.now();
  api('POST', `/api/chats/${chatId}/warm`).then((r) => { if (r?.ok) { S.ready[chatId] = Date.now(); fire('ready', chatId); } }).catch(() => {});
}
export const isReady = (chatId) => Date.now() - (S.ready[chatId] || 0) < 70e3;
export const squadRuns = (squadId) => S.runs.filter((r) => r.squadId === squadId);
export const squad = (id) => (S.squads || []).find((x) => x.id === id);
export const comp = (botId) => S.computers[botId] || { control: 'bot' };
// The Bot whose computer the current view is about.
export function focusBot() {
  if (S.route.name !== 'chat') return S.focusBot && bot(S.focusBot) ? S.focusBot : S.bots[0]?.id;
  const c = chat(S.route.id);
  if (!c) return null;
  if (c.kind === 'dm') return c.bot_ids[0];
  const running = S.runs.find((r) => r.chatId === c.id);
  return running?.botId || (c.bot_ids.includes(S.focusBot) ? S.focusBot : c.bot_ids[0]);
}

export function go(hash) {
  if (location.hash !== hash) location.hash = hash;
  else parseRoute();
}

export function parseRoute() {
  S.route = routeFromHash();
  fire('route');
}

export function toggleComputer(force) {
  S.showComputer = force ?? !S.showComputer;
  try { localStorage.setItem('tandem.computer', S.showComputer ? '1' : '0'); } catch {}
  fire('computer-toggle');
}

let es;
export function connectEvents() {
  es?.close();
  es = new EventSource('/api/events');
  const refreshing = new Set(['bots', 'chats', 'connectors', 'settings', 'members']);
  for (const t of refreshing) es.addEventListener(t, () => refresh());
  es.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.card && NEEDS_YOU.has(m.card.type)) {
      S.pending = (S.pending || []).filter((x) => x.id !== m.id);
      if (m.card.status === 'pending') S.pending.unshift(m);
    }
    const list = S.messages[m.chat_id];
    if (list) {
      const i = list.findIndex((x) => x.id === m.id);
      if (i >= 0) list[i] = m; else list.push(m);
    }
    const c = chat(m.chat_id);
    if (c) c.updated = Date.now();
    fire('message', m);
  });
  es.addEventListener('run', (e) => {
    const r = JSON.parse(e.data);
    S.runs = S.runs.filter((x) => !(x.chatId === r.chatId && x.botId === r.botId) && !(x.optimistic && x.chatId === r.chatId));
    if (!r.ended) S.runs.push(r);
    fire('run', r);
  });
  es.addEventListener('computer', (e) => { const c = JSON.parse(e.data); if (c.botId) S.computers[c.botId] = c; fire('computer', c); });
  for (const t of ['routines', 'skills', 'library', 'teach.limit', 'activity', 'company']) es.addEventListener(t, (e) => fire(t, JSON.parse(e.data || '{}')));
  es.addEventListener('mission', (e) => {
    const m = JSON.parse(e.data);
    S.missions = (S.missions || []).filter((x) => x.id !== m.id);
    if (!m.deleted) S.missions.unshift(m);
    fire('mission', m);
  });
  es.addEventListener('squad', (e) => {
    const q = JSON.parse(e.data);
    S.squads = [q, ...(S.squads || []).filter((x) => x.id !== q.id)];
    fire('squad', q);
  });
  es.addEventListener('usage', (e) => { S.settings.plan = JSON.parse(e.data); fire('usage'); });
  es.addEventListener('notify', (e) => fire('notify', JSON.parse(e.data)));
  es.onerror = () => { setTimeout(() => { if (es.readyState === 2) connectEvents(); }, 3000); };
}
