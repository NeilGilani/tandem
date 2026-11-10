// Company accounts: sign in once, every Bot has it. When you sign in to an app on any
// Bot's computer, Tandem saves that sign-in (the app's cookies) in your Mac's Keychain and
// puts it on every other Bot's computer: right away if it's awake, or as soon as it wakes.
// Bots never see the sign-in itself. Apps that share a sign-in (Gmail, Calendar, Drive)
// are one account.
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import { all, get, run, now, db, PATHS } from './db.js';
import { CATALOG, byId } from './catalog.js';
import * as computer from './computer.js';
import * as chats from './chats.js';
import { emit } from './bus.js';

db.exec(`CREATE TABLE IF NOT EXISTS accounts (
  key TEXT PRIMARY KEY, label TEXT, apps TEXT, source_bot TEXT, cookies INTEGER, shared TEXT DEFAULT 'all', updated INTEGER
)`);

const SERVICE = 'Tandem accounts';
// Each Tandem data folder has its own entries, so a test copy never touches your real sign-ins.
const NS = crypto.createHash('sha1').update(PATHS.data).digest('hex').slice(0, 8);
const item = (key) => `${NS}:${key}`;
const sh = (args) => new Promise((resolve, reject) => execFile('security', args, { maxBuffer: 8 << 20 }, (err, out) => (err ? reject(err) : resolve(out.trim()))));
const keyOf = (app) => [...(app.domains || [])].sort().join(',');
const appsFor = (key) => CATALOG.filter((a) => a.kind === 'browser' && keyOf(a) === key);
const matches = (cookie, domains) => { const d = cookie.domain.replace(/^\./, ''); return domains.some((x) => d === x || d.endsWith(`.${x}`)); };

export const list = () => all('SELECT key, label, apps, source_bot, cookies, shared, updated FROM accounts ORDER BY label')
  .map((r) => ({ ...r, apps: JSON.parse(r.apps || '[]'), shared: r.shared === 'all' ? 'all' : JSON.parse(r.shared || '[]') }));
export const forApp = (appId) => { const a = byId[appId]; return a ? list().find((r) => r.key === keyOf(a)) || null : null; };
const allowed = (acct, botId) => acct.shared === 'all' || acct.shared.includes(botId);

// Save the sign-in for an app from a Bot's computer. Needs the app's sign-in cookies.
export async function capture(botId, appId, { from = null } = {}) {
  const app = byId[appId];
  if (!app?.domains?.length) return false;
  const jar = (from || await computer.cookies(botId)).filter((c) => matches(c, app.domains));
  const nowS = Date.now() / 1000;
  if (!app.auth?.length || !jar.some((c) => app.auth.includes(c.name) && (c.expires === -1 || c.expires > nowS))) return false;
  const key = keyOf(app);
  const keep = jar.map(({ name, value, domain, path, expires, httpOnly, secure, sameSite, priority, partitionKey }) =>
    ({ name, value, domain, path, ...(expires > 0 ? { expires } : {}), httpOnly, secure, ...(sameSite ? { sameSite } : {}), ...(priority ? { priority } : {}), ...(partitionKey ? { partitionKey } : {}) }));
  await sh(['add-generic-password', '-U', '-s', SERVICE, '-a', item(key), '-l', `Tandem sign-in: ${app.category || app.name}`, '-w', JSON.stringify(keep)]);
  const apps = appsFor(key).map((a) => a.id);
  const label = apps.length > 1 ? (app.category || app.name) : app.name;
  run(`INSERT INTO accounts (key, label, apps, source_bot, cookies, updated) VALUES (?,?,?,?,?,?)
       ON CONFLICT(key) DO UPDATE SET label = excluded.label, apps = excluded.apps, source_bot = excluded.source_bot, cookies = excluded.cookies, updated = excluded.updated`,
  key, label, JSON.stringify(apps), botId, keep.length, now());
  emit('connectors');
  return true;
}

// Put a saved sign-in on a Bot's computer (its browser must be running).
async function apply(botId, key) {
  const raw = await sh(['find-generic-password', '-s', SERVICE, '-a', item(key), '-w']).catch(() => null);
  if (!raw) return false;
  await computer.setCookies(botId, JSON.parse(raw));
  return true;
}

// Everything this Bot is allowed to share, then recheck its app statuses.
let refreshFn = null;
export const onRefresh = (fn) => { refreshFn = fn; };
export async function applyAll(botId) {
  const accts = list().filter((a) => allowed(a, botId));
  let n = 0;
  for (const a of accts) if (await apply(botId, a.key).catch(() => false)) n++;
  if (n && refreshFn) await refreshFn(botId).catch(() => {});
  return n;
}

// You signed in on one Bot's computer: save it and give it to everyone else who's awake.
export async function share(sourceBot, appId) {
  if (!(await capture(sourceBot, appId).catch(() => false))) return 0;
  const acct = forApp(appId);
  let n = 0;
  for (const b of chats.listBots()) {
    if (b.id === sourceBot || !allowed(acct, b.id) || !(await computer.isRunning(b.id))) continue;
    if (await apply(b.id, acct.key).catch(() => false)) { n++; if (refreshFn) await refreshFn(b.id).catch(() => {}); }
  }
  return n;
}

// A Bot needs an app: use the team's sign-in if there is one. True if it's connected now.
export async function borrow(botId, appId) {
  const acct = forApp(appId);
  if (!acct || !allowed(acct, botId)) return false;
  await computer.ensureBrowser(botId);
  if (!(await apply(botId, acct.key).catch(() => false))) return false;
  if (refreshFn) await refreshFn(botId).catch(() => {});
  return true;
}

export function setShared(key, shared) {
  run('UPDATE accounts SET shared = ? WHERE key = ?', shared === 'all' ? 'all' : JSON.stringify([].concat(shared || [])), key);
  emit('connectors');
}

export async function forget(key) {
  await sh(['delete-generic-password', '-s', SERVICE, '-a', item(key)]).catch(() => {});
  run('DELETE FROM accounts WHERE key = ?', key);
  emit('connectors');
}

// Moving to laptops: bring the sign-ins from the Bots' old Mac browsers along, once.
export async function importFromMac(connected) {
  const done = new Set(list().map((a) => a.key));
  let n = 0;
  for (const { bot_id: botId, catalog_id: appId } of connected) {
    const app = byId[appId];
    if (!app || done.has(keyOf(app))) continue;
    const jar = await computer.macCookies(botId).catch(() => []);
    if (jar.length && await capture(botId, appId, { from: jar }).catch(() => false)) { done.add(keyOf(app)); n++; }
  }
  return n;
}

// Sessions rotate: every couple of hours, re-save each account from a Bot that's awake and signed in.
export function startKeepFresh(isConnected) {
  setInterval(async () => {
    for (const a of list()) {
      if (Date.now() - a.updated < 2 * 3600e3) continue;
      for (const b of chats.listBots()) {
        if (!(await computer.isRunning(b.id)) || !isConnected(b.id, a.apps[0])) continue;
        if (await capture(b.id, a.apps[0]).catch(() => false)) break;
      }
    }
  }, 20 * 60e3);
}
