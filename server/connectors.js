// Installed connectors. Status follows Grok Bot's wording:
//   Added       — installed, not signed in yet
//   Needs auth  — sign-in expired or never finished
//   Connected   — signed in and usable by every Bot
import { all, get, run, now, uid, parseRow } from './db.js';
import { CATALOG, byId } from './catalog.js';
import * as computer from './computer.js';
import { emit } from './bus.js';

export function installed() {
  return all('SELECT * FROM connectors ORDER BY added').map((r) => {
    const c = parseRow(r, ['config']);
    return { ...byId[c.catalog_id], ...c, catalog: byId[c.catalog_id] || null };
  });
}

export function catalogWithStatus() {
  const mine = Object.fromEntries(installed().map((c) => [c.catalog_id, c]));
  return CATALOG.map((c) => ({ ...c, status: mine[c.id]?.status || null, installed_id: mine[c.id]?.id || null }));
}

export function add(catalogId) {
  const c = byId[catalogId];
  if (!c) throw new Error(`Unknown app: ${catalogId}`);
  const existing = get('SELECT * FROM connectors WHERE catalog_id = ?', catalogId);
  if (existing) return existing;
  const id = uid('con_');
  const status = c.kind === 'mac' ? 'Connected' : 'Added';
  run('INSERT INTO connectors (id, catalog_id, name, status, config, added) VALUES (?,?,?,?,?,?)', id, catalogId, c.name, status, '{}', now());
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

export async function remove(id) {
  const c = get('SELECT * FROM connectors WHERE id = ?', id);
  if (!c) return;
  const cat = byId[c.catalog_id];
  // Removing an app signs you out of it, unless another installed app shares its domains.
  if (cat?.kind === 'browser') {
    const others = installed().filter((o) => o.id !== id && o.kind === 'browser');
    const shared = new Set(others.flatMap((o) => o.domains || []));
    const domains = cat.domains.filter((d) => !shared.has(d));
    if (domains.length) await computer.clearCookies(domains).catch(() => {});
  }
  run('DELETE FROM connectors WHERE id = ?', id);
  emit('connectors');
}

export function setStatus(id, status) {
  run('UPDATE connectors SET status = ? WHERE id = ?', status, id);
  emit('connectors');
}

// Check sign-in for every browser app from the shared computer's cookies.
export async function refresh() {
  const list = installed().filter((c) => c.kind === 'browser');
  if (!list.length) return;
  const jar = await computer.cookies();
  if (!jar.length) return;
  for (const c of list) {
    if (!c.auth?.length) continue; // unknown cookie names: keep the status you confirmed
    const nowS = Date.now() / 1000;
    const signedIn = jar.some((k) => c.auth.includes(k.name)
      && c.domains.some((d) => k.domain.replace(/^\./, '').endsWith(d))
      && (k.expires === -1 || k.expires > nowS));
    const next = signedIn ? 'Connected' : (c.status === 'Added' ? 'Added' : 'Needs auth');
    if (next !== c.status) setStatus(c.id, next);
  }
}

export async function signIn(id, { botId = null, chatId = null } = {}) {
  const c = installed().find((x) => x.id === id);
  if (!c || c.kind !== 'browser') throw new Error('Only browser apps need a sign-in');
  await computer.openUrl(c.url);
  pendingSignIn = id;
  computer.startTakeover({ reason: `Sign in to ${c.name}, then press I'm done`, botId, chatId });
  computer.bringToFront();
  return c;
}

let pendingSignIn = null;

// After "I'm done": apps with known cookies get checked; others are trusted as connected.
export async function afterTakeover() {
  const id = pendingSignIn;
  pendingSignIn = null;
  const c = id && installed().find((x) => x.id === id);
  if (c && !c.auth?.length) setStatus(c.id, 'Connected');
  await refresh();
  const after = c && installed().find((x) => x.id === id);
  if (after && after.status === 'Added') setStatus(id, 'Needs auth');
}

export function markConnected(id) { setStatus(id, 'Connected'); }

// The text every Bot gets about apps it can use.
export function promptBlock() {
  const list = installed();
  if (!list.length) return 'No apps are connected yet. If a task needs one, call request_connect with the app name.';
  return list.map((c) => {
    if (c.catalog_id === 'custom') return `- ${c.name} (custom MCP app) — tools are available under mcp__${mcpName(c)}__*`;
    const where = c.kind === 'mac' ? `native tools: ${c.tools.join(', ')}` : `use in the computer browser at ${c.url}`;
    return `- ${c.name} [${c.status}] — ${where}. ${c.tips || ''}`;
  }).join('\n');
}

export const mcpName = (c) => 'app_' + c.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

export function customMcpServers() {
  const out = {};
  for (const c of installed().filter((x) => x.catalog_id === 'custom')) {
    const cfg = c.config || {};
    out[mcpName(c)] = cfg.url ? { type: 'http', url: cfg.url } : { command: cfg.command, args: cfg.args || [], env: cfg.env || {} };
  }
  return out;
}
