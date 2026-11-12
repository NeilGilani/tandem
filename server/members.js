// Teammates who share your Bots, like a cofounder. Each gets their own sign-in link (revocable
// on its own), their requests carry their name, and their decision cards go to them. A few
// things stay yours alone: your Gmail, app sign-ins and saved logins, settings, and who's on
// the team. Optional company API key so shared use bills to the company, not your Claude plan.
import crypto from 'node:crypto';
import * as secrets from './secrets.js';
import { db, all, get, run, now, uid, PATHS, setting, setSetting } from './db.js';
import { setApiKey } from './claude.js';
import { emit } from './bus.js';

db.exec(`CREATE TABLE IF NOT EXISTS members (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT DEFAULT 'cofounder', token_hash TEXT NOT NULL,
  created INTEGER, last_seen INTEGER, revoked INTEGER
);`);

const hash = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const pub = ({ id, name, role, created, last_seen }) => ({ id, name, role, created, last_seen });
export const OWNER = 'user';
export const ownerFirst = () => (setting('user_name') || '').trim().split(/\s+/)[0] || 'the owner';

export const list = () => all('SELECT * FROM members WHERE revoked IS NULL ORDER BY created').map(pub);
export const byId = (id) => { const m = get('SELECT * FROM members WHERE id = ? AND revoked IS NULL', id); return m ? pub(m) : null; };

// A new teammate: returns the token once (only its hash is stored).
export function add({ name, role = 'cofounder' }) {
  name = String(name || '').trim().slice(0, 40);
  if (!name) throw new Error('Give them a name');
  const token = crypto.randomBytes(24).toString('base64url');
  const id = uid('mem_');
  run('INSERT INTO members (id, name, role, token_hash, created) VALUES (?,?,?,?,?)', id, name, String(role || 'cofounder').slice(0, 40), hash(token), now());
  emit('members');
  return { member: byId(id), token };
}

// A fresh link for someone who lost theirs; the old one stops working.
export function relink(id) {
  if (!byId(id)) throw new Error('No such teammate');
  const token = crypto.randomBytes(24).toString('base64url');
  run('UPDATE members SET token_hash = ? WHERE id = ?', hash(token), id);
  return { member: byId(id), token };
}

export function revoke(id) {
  run('UPDATE members SET revoked = ? WHERE id = ?', now(), id);
  emit('members');
}

const seen = new Map();
export function fromToken(token) {
  if (!token) return null;
  const m = get('SELECT * FROM members WHERE token_hash = ? AND revoked IS NULL', hash(token));
  if (!m) return null;
  if (now() - (seen.get(m.id) || 0) > 60e3) { seen.set(m.id, now()); run('UPDATE members SET last_seen = ? WHERE id = ?', now(), m.id); }
  return pub(m);
}

// Who is asking: you (on this Mac or with your own link), or a teammate.
export const owner = (name) => ({ id: OWNER, name, role: 'owner', owner: true });
export const nameOf = (id, ownerName) => (!id || id === OWNER ? ownerName : byId(id)?.name || 'A teammate');

// Things only the owner can do, as [method, path regex].
const OWNER_ONLY = [
  [/^(POST|DELETE|PATCH)$/, /^\/api\/gmail$/],
  [/./, /^\/api\/accounts/],
  [/^(POST|DELETE|PATCH|PUT)$/, /^\/api\/connectors/],
  [/./, /^\/api\/vault/],
  [/./, /^\/api\/members/],
  [/^(PATCH|POST)$/, /^\/api\/(settings|rules|billing|network)/],
  [/^DELETE$/, /^\/api\/rules\//],
  [/^POST$/, /^\/api\/memory\/import$/],
  [/^DELETE$/, /^\/api\/bots\/[^/]+$/],
  [/^POST$/, /^\/api\/bots\/[^/]+\/primary$/],
  [/^POST$/, /^\/api\/computer\/(takeover|input|open|teach\/start|teach\/stop|restart)$/],
];
export const ownerOnly = (method, p) => OWNER_ONLY.some(([m, re]) => m.test(method) && re.test(p));

// Card answers a teammate can't give: anything that uses your accounts or spends on your behalf.
export function canResolve(who, card, payload = {}) {
  if (who.owner) return true;
  if (['gmail_connect', 'connect', 'secret', 'hire', 'skill_draft', 'takeover'].includes(card.type)) return false;
  if (card.type === 'draft') return payload.action === 'discard';
  if (card.type === 'approval') return card.for === who.id;
  return true; // questions
}

// ---- Company API key ----------------------------------------------------------------------
const SERVICE = 'Tandem accounts';
const NS = crypto.createHash('sha1').update(PATHS.data).digest('hex').slice(0, 8);
const ITEM = `${NS}:anthropic-api-key`;

export const billing = () => ({ mode: setting('billing_mode') === 'api' ? 'api' : 'plan', key_hint: setting('api_key_hint') || '' });

export async function loadApiKey() {
  if (setting('billing_mode') !== 'api') return setApiKey(null);
  setApiKey(await secrets.get(SERVICE, ITEM).catch(() => null));
}

export async function setBilling({ mode, apiKey }) {
  if (mode === 'plan') { setSetting('billing_mode', 'plan'); setApiKey(null); emit('settings'); return billing(); }
  const key = String(apiKey || '').trim();
  if (key) {
    if (!/^sk-ant-/.test(key)) throw new Error('That doesn\'t look like an Anthropic API key (it starts with sk-ant-).');
    const r = await fetch('https://api.anthropic.com/v1/models?limit=1', { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' } }).catch(() => null);
    if (!r) throw new Error('Couldn\'t reach Anthropic to check the key. Try again.');
    if (r.status === 401 || r.status === 403) throw new Error('Anthropic rejected that key. Copy it again from console.anthropic.com.');
    await secrets.set(SERVICE, ITEM, key, 'Tandem: Anthropic API key');
    setSetting('api_key_hint', `${key.slice(0, 10)}…${key.slice(-4)}`);
  } else if (!setting('api_key_hint')) throw new Error('Paste the company API key first.');
  setSetting('billing_mode', 'api');
  await loadApiKey();
  emit('settings');
  return billing();
}
