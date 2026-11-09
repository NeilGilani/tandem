// Skills: one private library shared by all your Bots. Each skill is a folder with
// a SKILL.md (frontmatter name + description, then the steps). A skill can be
// switched off for a particular Bot under Connect apps → Private skills.
import fs from 'node:fs';
import path from 'node:path';
import { PATHS, all, get, run, now } from './db.js';
import { emit } from './bus.js';

export const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'skill';
const fileOf = (slug) => path.join(PATHS.skills, slug, 'SKILL.md');

export function list() {
  return all('SELECT * FROM skills ORDER BY name');
}

export function read(slug) {
  const row = get('SELECT * FROM skills WHERE slug = ?', slug)
    || get('SELECT * FROM skills WHERE lower(name) = lower(?)', slug);
  if (!row) return null;
  let body = '';
  try { body = fs.readFileSync(fileOf(row.slug), 'utf8').replace(/^---[\s\S]*?---\n?/, ''); } catch {}
  return { ...row, body };
}

export function save({ name, description = '', body = '', slug, origin = 'private' }) {
  if (!name) throw new Error('A skill needs a name');
  slug = slug || slugify(name);
  fs.mkdirSync(path.dirname(fileOf(slug)), { recursive: true });
  const md = `---\nname: ${name}\ndescription: ${description.replace(/\n/g, ' ')}\n---\n${body.trim()}\n`;
  fs.writeFileSync(fileOf(slug), md);
  const existing = get('SELECT slug FROM skills WHERE slug = ?', slug);
  if (existing) run('UPDATE skills SET name=?, description=?, updated=? WHERE slug=?', name, description, now(), slug);
  else run('INSERT INTO skills (slug, name, description, origin, created, updated) VALUES (?,?,?,?,?,?)', slug, name, description, origin, now(), now());
  emit('skills');
  return read(slug);
}

export function remove(slug) {
  fs.rmSync(path.join(PATHS.skills, slug), { recursive: true, force: true });
  run('DELETE FROM skills WHERE slug = ?', slug);
  run('DELETE FROM skill_disabled WHERE slug = ?', slug);
  emit('skills');
}

export function enabledFor(botId) {
  const off = new Set(all('SELECT slug FROM skill_disabled WHERE bot_id = ?', botId).map((r) => r.slug));
  return list().filter((s) => !off.has(s.slug));
}

export function setEnabled(botId, slug, on) {
  if (on) run('DELETE FROM skill_disabled WHERE bot_id = ? AND slug = ?', botId, slug);
  else run('INSERT OR IGNORE INTO skill_disabled (bot_id, slug) VALUES (?, ?)', botId, slug);
  emit('skills');
}

export function promptBlock(botId) {
  const mine = enabledFor(botId);
  if (!mine.length) return 'No skills saved yet.';
  return mine.map((s) => `- ${s.name}: ${s.description || '(no description)'}`).join('\n');
}
