// Connect apps. Adding an app is global (it appears for every Bot), but signing in
// happens per Bot, because each Bot has its own computer and browser. Status words
// follow Grok Bot:
//   Added       — installed, this Bot isn't signed in yet
//   Needs auth  — this Bot's sign-in expired or never finished
//   Connected   — this Bot is signed in
import { all, get, run, now, uid, parseRow } from './db.js';
import { CATALOG, byId } from './catalog.js';
import * as computer from './computer.js';
import { emit } from './bus.js';

const rows = () => all('SELECT * FROM connectors ORDER BY added').map((r) => parseRow(r, ['config']));

function statusFor(botId, c) {
  if (c.catalog_id === 'custom' || byId[c.catalog_id]?.kind === 'mac') return 'Connected';
  if (!botId) return c.status;
  return get('SELECT status FROM connector_status WHERE bot_id = ? AND connector_id = ?', botId, c.id)?.status || 'Added';
}

export function installed(botId = null) {
  return rows().map((c) => ({ ...byId[c.catalog_id], ...c, catalog: byId[c.catalog_id] || null, status: statusFor(botId, c) }));
}

export function catalogWithStatus(botId = null) {
  const mine = Object.fromEntries(installed(botId).map((c) => [c.catalog_id, c]));
  return CATALOG.map((c) => ({ ...c, status: mine[c.id]?.status || null, installed_id: mine[c.id]?.id || null }));
}

export function add(catalogId) {
  const c = byId[catalogId];
  if (!c) throw new Error(`Unknown app: ${catalogId}`);
  const existing = get('SELECT * FROM connectors WHERE catalog_id = ?', catalogId);
  if (existing) return existing;
  const id = uid('con_');
  run('INSERT INTO connectors (id, catalog_id, name, status, config, added) VALUES (?,?,?,?,?,?)', id, catalogId, c.name, c.kind === 'mac' ? 'Connected' : 'Added', '{}', now());
  emit('connectors');
  return get('SELECT * FROM connectors WHERE id = ?', id);
}

// Custom MCP server: { name, url } or { name, command, args }
export function addCustom({ name, url, command, args = [], env = {} }) {
  if (!name || (!url && !command)) throw new Error('A custom app needs a name and a URL or a command');
  const id = uid('con_');
  run('INSERT INTO connectors (id, catalog_id, name, status, config, added) VALUES (?,?,?,?,?,?)',
    id, 'custom', name, 'Connected', JSON.stringify({ url, command, args, env }), now());
  emit('connectors');
  return id;
}

// Removing an app signs every Bot out of it (unless another app shares its domains).
export async function remove(id) {
  const c = get('SELECT * FROM connectors WHERE id = ?', id);
  if (!c) return;
  const cat = byId[c.catalog_id];
  if (cat?.kind === 'browser') {
    const shared = new Set(rows().filter((o) => o.id !== id && byId[o.catalog_id]?.kind === 'browser').flatMap((o) => byId[o.catalog_id].domains));
    const domains = cat.domains.filter((d) => !shared.has(d));
    if (domains.length) {
      for (const b of all('SELECT id FROM bots')) if (await computer.isRunning(b.id)) await computer.clearCookies(b.id, domains).catch(() => {});
    }
  }
  run('DELETE FROM connector_status WHERE connector_id = ?', id);
  run('DELETE FROM connectors WHERE id = ?', id);
  emit('connectors');
}

export function setStatus(botId, id, status) {
  run('INSERT INTO connector_status (bot_id, connector_id, status) VALUES (?,?,?) ON CONFLICT(bot_id, connector_id) DO UPDATE SET status = excluded.status', botId, id, status);
  emit('connectors', { botId });
}

// Check one Bot's sign-ins from its browser cookies (only if its browser is running).
export async function refresh(botId) {
  if (!botId) { for (const b of all('SELECT id FROM bots')) await refresh(b.id); return; }
  if (!(await computer.isRunning(botId))) return;
  const list = installed(botId).filter((c) => c.kind === 'browser' && c.auth?.length);
  if (!list.length) return;
  const jar = await computer.cookies(botId);
  if (!jar.length) return;
  const nowS = Date.now() / 1000;
  for (const c of list) {
    const signedIn = jar.some((k) => c.auth.includes(k.name)
      && c.domains.some((d) => k.domain.replace(/^\./, '').endsWith(d))
      && (k.expires === -1 || k.expires > nowS));
    const next = signedIn ? 'Connected' : (c.status === 'Added' ? 'Added' : 'Needs auth');
    if (next !== c.status) setStatus(botId, c.id, next);
  }
}

const pendingSignIn = new Map(); // botId -> connector id

export async function signIn(id, { botId, chatId = null } = {}) {
  if (!botId) throw new Error('Choose which Bot to sign in for');
  const c = installed(botId).find((x) => x.id === id);
  if (!c || c.kind !== 'browser') throw new Error('Only browser apps need a sign-in');
  await computer.openUrl(botId, c.url);
  pendingSignIn.set(botId, id);
  computer.startTakeover({ botId, reason: `Sign in to ${c.name}, then press I'm done`, chatId });
  await computer.bringToFront(botId);
  return c;
}

// After "I'm done": apps with known cookies get checked; others are trusted as connected.
export async function afterTakeover(botId) {
  const id = pendingSignIn.get(botId);
  pendingSignIn.delete(botId);
  const c = id && installed(botId).find((x) => x.id === id);
  if (c && !c.auth?.length) setStatus(botId, c.id, 'Connected');
  await refresh(botId);
  const after = c && installed(botId).find((x) => x.id === id);
  if (after && after.status === 'Added') setStatus(botId, id, 'Needs auth');
}

export const markConnected = (botId, id) => setStatus(botId, id, 'Connected');

// The text a Bot gets about apps it can use.
export function promptBlock(botId) {
  const list = installed(botId);
  if (!list.length) return 'No apps are connected yet. If a task needs one, call request_connect with the app name.';
  return list.map((c) => {
    if (c.catalog_id === 'custom') return `- ${c.name} (custom MCP app). Its tools are available under mcp__${mcpName(c)}__*`;
    const where = c.kind === 'mac' ? `native tools: ${c.tools.join(', ')}` : `use in your browser at ${c.url}`;
    return `- ${c.name} [${c.status} on your computer]: ${where}. ${c.tips || ''}`;
  }).join('\n');
}

export const mcpName = (c) => 'app_' + c.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

export function customMcpServers() {
  const out = {};
  for (const c of rows().filter((x) => x.catalog_id === 'custom')) {
    const cfg = c.config || {};
    out[mcpName(c)] = cfg.url ? { type: 'http', url: cfg.url } : { command: cfg.command, args: cfg.args || [], env: cfg.env || {} };
  }
  return out;
}

// v0.1 stored one status per app. Carry it over to the Bot that inherits the old computer.
export function migrateLegacy(botId) {
  if (!botId) return;
  for (const c of rows()) {
    if (byId[c.catalog_id]?.kind !== 'browser') continue;
    if (!get('SELECT 1 FROM connector_status WHERE bot_id = ? AND connector_id = ?', botId, c.id)) {
      run('INSERT INTO connector_status (bot_id, connector_id, status) VALUES (?,?,?)', botId, c.id, c.status || 'Added');
    }
  }
}
