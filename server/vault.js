// Vault: saved logins and secrets. Values live in the macOS Keychain (service
// "Tandem"); only names and sites are in the database. Bots can ask the Vault to
// fill a login on the current page, but never receive the values themselves.
import { execFile } from 'node:child_process';
import { all, get, run, uid, now } from './db.js';

const SERVICE = 'Tandem';
const sh = (args) => new Promise((resolve, reject) =>
  execFile('security', args, (err, stdout) => (err ? reject(err) : resolve(stdout.trim()))));

export const list = () => all('SELECT id, name, kind, site, username, created FROM vault ORDER BY name');

export async function save({ name, kind = 'login', site = '', username = '', secret }) {
  if (!name || !secret) throw new Error('name and secret are required');
  const existing = get('SELECT id FROM vault WHERE name = ?', name);
  const id = existing?.id || uid('v_');
  await sh(['add-generic-password', '-U', '-s', SERVICE, '-a', id, '-l', `Tandem: ${name}`, '-w', secret]);
  if (existing) run('UPDATE vault SET kind=?, site=?, username=? WHERE id=?', kind, site, username, id);
  else run('INSERT INTO vault (id, name, kind, site, username, created) VALUES (?,?,?,?,?,?)', id, name, kind, site, username, now());
  return { id, name, kind, site, username };
}

export async function reveal(id) {
  return sh(['find-generic-password', '-s', SERVICE, '-a', id, '-w']);
}

export async function remove(id) {
  await sh(['delete-generic-password', '-s', SERVICE, '-a', id]).catch(() => {});
  run('DELETE FROM vault WHERE id = ?', id);
}

export function find(nameOrSite) {
  const q = String(nameOrSite || '').toLowerCase();
  return list().find((v) => v.name.toLowerCase() === q)
    || list().find((v) => v.site && (q.includes(v.site.toLowerCase()) || v.site.toLowerCase().includes(q)))
    || list().find((v) => v.name.toLowerCase().includes(q));
}
