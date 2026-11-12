// Vault: saved logins and secrets. Values live in the macOS Keychain (service
// "Tandem"), or on Windows in Tandem's encrypted secrets file (see secrets.js); only names and sites are in the database. Bots can ask the Vault to
// fill a login on the current page, but never receive the values themselves.
import * as secrets from './secrets.js';
import { all, get, run, uid, now } from './db.js';

const SERVICE = 'Tandem';

export const list = () => all('SELECT id, name, kind, site, username, created FROM vault ORDER BY name');

export async function save({ name, kind = 'login', site = '', username = '', secret }) {
  if (!name || !secret) throw new Error('name and secret are required');
  const existing = get('SELECT id FROM vault WHERE name = ?', name);
  const id = existing?.id || uid('v_');
  await secrets.set(SERVICE, id, secret, `Tandem: ${name}`);
  if (existing) run('UPDATE vault SET kind=?, site=?, username=? WHERE id=?', kind, site, username, id);
  else run('INSERT INTO vault (id, name, kind, site, username, created) VALUES (?,?,?,?,?,?)', id, name, kind, site, username, now());
  return { id, name, kind, site, username };
}

export async function reveal(id) {
  return secrets.get(SERVICE, id);
}

export async function remove(id) {
  await secrets.remove(SERVICE, id).catch(() => {});
  run('DELETE FROM vault WHERE id = ?', id);
}

export function find(nameOrSite) {
  const q = String(nameOrSite || '').toLowerCase();
  return list().find((v) => v.name.toLowerCase() === q)
    || list().find((v) => v.site && (q.includes(v.site.toLowerCase()) || v.site.toLowerCase().includes(q)))
    || list().find((v) => v.name.toLowerCase().includes(q));
}
