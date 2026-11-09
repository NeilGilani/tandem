// Memory: each Bot keeps its own rules, preferences and a dated work log.
// Facts about you (name, time zone, …) are shared by all your Bots, tagged with the
// Bot that saved them so deleting that Bot deletes them too. Group chats don't share
// one Bot's memory with the others.
import fs from 'node:fs';
import path from 'node:path';
import { PATHS, uid } from './db.js';

const file = (name) => path.join(PATHS.memory, `${name}.json`);
const load = (name, fallback) => { try { return JSON.parse(fs.readFileSync(file(name), 'utf8')); } catch { return fallback; } };
const save = (name, data) => fs.writeFileSync(file(name), JSON.stringify(data, null, 2));

const botMem = (botId) => load(botId, { facts: [], log: [] });
const youMem = () => load('_you', { facts: [] });

export function remember(botId, text, { aboutUser = false } = {}) {
  const fact = { id: uid('m_'), text: String(text).trim(), at: new Date().toISOString() };
  if (aboutUser) {
    const y = youMem();
    y.facts.push({ ...fact, bot: botId });
    save('_you', y);
  } else {
    const m = botMem(botId);
    m.facts.push(fact);
    save(botId, m);
  }
  return fact;
}

export function forget(botId, query) {
  const q = String(query).toLowerCase();
  const m = botMem(botId);
  const y = youMem();
  const before = m.facts.length + y.facts.length;
  m.facts = m.facts.filter((f) => f.id !== query && !f.text.toLowerCase().includes(q));
  y.facts = y.facts.filter((f) => !(f.id === query || (f.bot === botId && f.text.toLowerCase().includes(q))));
  save(botId, m);
  save('_you', y);
  return before - (m.facts.length + y.facts.length);
}

export function logWork(botId, text) {
  const m = botMem(botId);
  m.log.push({ at: new Date().toISOString(), text: String(text).trim() });
  m.log = m.log.slice(-300);
  save(botId, m);
}

export function recall(botId) {
  return { bot: botMem(botId), you: youMem() };
}

export function promptBlock(botId) {
  const { bot, you } = recall(botId);
  const lines = [];
  lines.push('About the user (shared by all Bots):');
  lines.push(you.facts.length ? you.facts.map((f) => `- ${f.text}`).join('\n') : '- (nothing saved yet)');
  lines.push('\nYour memory (your job, rules and preferences):');
  lines.push(bot.facts.length ? bot.facts.map((f) => `- ${f.text}`).join('\n') : '- (empty — you have no job yet; your first conversation sets it)');
  if (bot.log.length) {
    lines.push('\nRecent work log:');
    lines.push(bot.log.slice(-15).map((l) => `- ${l.at.slice(0, 16).replace('T', ' ')} ${l.text}`).join('\n'));
  }
  return lines.join('\n');
}

export function deleteBot(botId) {
  try { fs.unlinkSync(file(botId)); } catch {}
  const y = youMem();
  y.facts = y.facts.filter((f) => f.bot !== botId);
  save('_you', y);
}

export function copy(fromBot, toBot) {
  // Duplicate copies profile/skills/routines, not learned memory.
  save(toBot, { facts: [], log: [] });
}

export function importMemory(botId, text) {
  const lines = String(text).split(/\n+/).map((l) => l.replace(/^[-*•\d.)\s]+/, '').trim()).filter((l) => l.length > 2);
  for (const l of lines.slice(0, 500)) remember(botId, l, { aboutUser: true });
  return lines.length;
}
