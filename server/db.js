// SQLite store (built into Node) plus the on-disk layout of the shared computer.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA = process.env.TANDEM_DATA || path.join(ROOT, 'data');
export const PATHS = {
  data: DATA,
  computer: path.join(DATA, 'computer'),
  workspace: path.join(DATA, 'computer', 'workspace'),
  chrome: path.join(DATA, 'computer', 'chrome-profile'),
  memory: path.join(DATA, 'memory'),
  skills: path.join(DATA, 'skills'),
  uploads: path.join(DATA, 'uploads'),
  teach: path.join(DATA, 'teach'),
  runtime: path.join(DATA, 'runtime'),
};
for (const p of Object.values(PATHS)) fs.mkdirSync(p, { recursive: true });

export const db = new DatabaseSync(path.join(DATA, 'tandem.db'));
db.exec(`
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS bots (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, label TEXT DEFAULT '',
  shape TEXT DEFAULT 'circle', color TEXT DEFAULT '#6d5dfc', avatar TEXT,
  section TEXT DEFAULT '', pinned INTEGER DEFAULT 0, hidden INTEGER DEFAULT 0,
  is_primary INTEGER DEFAULT 0, notify INTEGER DEFAULT 1, drafts INTEGER DEFAULT 1,
  template TEXT, created INTEGER
);
CREATE TABLE IF NOT EXISTS chats (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT, bot_ids TEXT NOT NULL,
  created INTEGER, updated INTEGER
);
CREATE TABLE IF NOT EXISTS chat_sessions (
  chat_id TEXT, bot_id TEXT, session_id TEXT, PRIMARY KEY (chat_id, bot_id)
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, author TEXT NOT NULL, bot_id TEXT,
  text TEXT DEFAULT '', parent_id TEXT, reactions TEXT DEFAULT '{}', card TEXT,
  attachments TEXT DEFAULT '[]', meta TEXT DEFAULT '{}', created INTEGER
);
CREATE INDEX IF NOT EXISTS messages_chat ON messages(chat_id, created);
CREATE TABLE IF NOT EXISTS routines (
  id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, name TEXT, instruction TEXT,
  trigger TEXT DEFAULT 'schedule', schedule_text TEXT, cron TEXT, when_text TEXT,
  webhook_secret TEXT, paused INTEGER DEFAULT 0, next_run INTEGER, created INTEGER
);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY, routine_id TEXT, status TEXT, reason TEXT,
  started INTEGER, ended INTEGER
);
CREATE TABLE IF NOT EXISTS skills (
  slug TEXT PRIMARY KEY, name TEXT, description TEXT, origin TEXT DEFAULT 'private',
  created INTEGER, updated INTEGER
);
CREATE TABLE IF NOT EXISTS skill_disabled (bot_id TEXT, slug TEXT, PRIMARY KEY (bot_id, slug));
CREATE TABLE IF NOT EXISTS connectors (
  id TEXT PRIMARY KEY, catalog_id TEXT, name TEXT, status TEXT, config TEXT DEFAULT '{}', added INTEGER
);
CREATE TABLE IF NOT EXISTS rules (id TEXT PRIMARY KEY, kind TEXT, text TEXT, created INTEGER);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS library (
  id TEXT PRIMARY KEY, bot_id TEXT, kind TEXT, title TEXT, ref TEXT,
  visibility TEXT DEFAULT 'Private', created INTEGER
);
CREATE TABLE IF NOT EXISTS usage (
  id TEXT PRIMARY KEY, bot_id TEXT, model TEXT, cost REAL, input_tokens INTEGER,
  output_tokens INTEGER, origin TEXT, created INTEGER
);
CREATE TABLE IF NOT EXISTS vault (
  id TEXT PRIMARY KEY, name TEXT, kind TEXT, site TEXT, username TEXT, created INTEGER
);
CREATE TABLE IF NOT EXISTS sections (name TEXT PRIMARY KEY, position INTEGER);
`);

export const uid = (p = '') => p + crypto.randomBytes(8).toString('hex');
export const now = () => Date.now();

export const all = (sql, ...a) => db.prepare(sql).all(...a);
export const get = (sql, ...a) => db.prepare(sql).get(...a);
export const run = (sql, ...a) => db.prepare(sql).run(...a);

const DEFAULT_SETTINGS = {
  auto_review: '1',
  timezone: 'auto',
  local_execution: 'ask', // ask | always | never
  theme: 'system',
  access_token: crypto.randomBytes(16).toString('hex'),
};
for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
  run('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)', k, v);
}
export const setting = (k) => get('SELECT value FROM settings WHERE key = ?', k)?.value;
export const setSetting = (k, v) =>
  run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', k, String(v));

export function timezone() {
  const tz = setting('timezone');
  return !tz || tz === 'auto' ? Intl.DateTimeFormat().resolvedOptions().timeZone : tz;
}

export function parseRow(row, jsonCols = []) {
  if (!row) return row;
  const out = { ...row };
  for (const c of jsonCols) if (out[c] != null) { try { out[c] = JSON.parse(out[c]); } catch {} }
  return out;
}
