// Secrets: saved logins, sign-in cookies, app passwords and API keys.
//   macOS    the Keychain (`security`), as before.
//   Windows  an AES-256-GCM file in the data folder whose key is protected by Windows
//            (DPAPI, tied to your Windows account), so the file is useless anywhere else.
//   Linux    the same file, with a key only your user can read.
// Values never go in the database.
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from './db.js';

const MAC = process.platform === 'darwin';
const WIN = process.platform === 'win32';
export const WHERE = MAC ? 'your Mac\'s Keychain' : WIN ? 'Windows, encrypted for your account' : 'an encrypted file on this computer';

const security = (args) => new Promise((resolve, reject) =>
  execFile('security', args, { maxBuffer: 8 << 20 }, (err, out) => (err ? reject(err) : resolve(out.trim()))));

// ---- file store (Windows, Linux) -------------------------------------------------------
const FILE = path.join(PATHS.data, 'secrets.json');
const KEY_FILE = path.join(PATHS.data, 'secrets.key');

// DPAPI through PowerShell; the value travels on stdin, never on the command line.
function dpapi(mode, b64) {
  const script = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); ` +
    `[Console]::Out.Write([Convert]::ToBase64String([Security.Cryptography.ProtectedData]::${mode}($b,$null,'CurrentUser')))`;
  return new Promise((resolve, reject) => {
    const child = execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, timeout: 30000 }, (err, out) => (err ? reject(new Error('Windows could not protect the secrets key')) : resolve(out.trim())));
    child.stdin.end(b64);
  });
}

let keyPromise = null;
function masterKey() {
  keyPromise ||= (async () => {
    if (fs.existsSync(KEY_FILE)) {
      const raw = fs.readFileSync(KEY_FILE, 'utf8').trim();
      return Buffer.from(WIN ? await dpapi('Unprotect', raw) : raw, 'base64');
    }
    const key = crypto.randomBytes(32);
    const b64 = key.toString('base64');
    fs.writeFileSync(KEY_FILE, WIN ? await dpapi('Protect', b64) : b64, { mode: 0o600 });
    return key;
  })().catch((e) => { keyPromise = null; throw e; });
  return keyPromise;
}

const readStore = () => { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return {}; } };
function writeStore(store) {
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store), { mode: 0o600 });
  fs.renameSync(tmp, FILE);
}
const slot = (service, account) => `${service}\n${account}`;

// ---- API -------------------------------------------------------------------------------
export async function set(service, account, value, label = '') {
  if (MAC) { await security(['add-generic-password', '-U', '-s', service, '-a', account, '-l', label || service, '-w', value]); return; }
  const key = await masterKey();
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([c.update(String(value), 'utf8'), c.final()]);
  const store = readStore();
  store[slot(service, account)] = { iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64'), label };
  writeStore(store);
}

// Rejects when there is no such secret (callers decide what that means).
export async function get(service, account) {
  if (MAC) return security(['find-generic-password', '-s', service, '-a', account, '-w']);
  const e = readStore()[slot(service, account)];
  if (!e) throw new Error('No such secret');
  const d = crypto.createDecipheriv('aes-256-gcm', await masterKey(), Buffer.from(e.iv, 'base64'));
  d.setAuthTag(Buffer.from(e.tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(e.data, 'base64')), d.final()]).toString('utf8');
}

export async function remove(service, account) {
  if (MAC) { await security(['delete-generic-password', '-s', service, '-a', account]); return; }
  const store = readStore();
  if (!(slot(service, account) in store)) throw new Error('No such secret');
  delete store[slot(service, account)];
  writeStore(store);
}
