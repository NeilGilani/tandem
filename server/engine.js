// Runs Bots. Each turn is a headless Claude Code run (`claude -p`, stream-json) that
// resumes that Bot's session for that conversation, with the Tandem tools, the
// shared browser (Playwright MCP over CDP) and any custom MCP apps attached.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROOT, PATHS, uid, now, run as sql, setting } from './db.js';
import { CLAUDE_BIN, childEnv, quickJson } from './claude.js';
import { emit } from './bus.js';
import { pickModel } from './router.js';
import * as chats from './chats.js';
import * as prompt from './prompt.js';
import * as approvals from './approvals.js';
import * as connectors from './connectors.js';
import * as computer from './computer.js';
import * as memory from './memory.js';

export let PORT = 4747;
export const setPort = (p) => { PORT = p; };

const active = new Map(); // `${chatId}:${botId}` -> run
const queues = new Map(); // same key -> promise chain for background work

const READ_ONLY_TOOLS = [
  'Read', 'Glob', 'Grep', 'LS', 'WebSearch', 'TodoWrite', 'Task', 'NotebookRead',
  'mcp__tandem', // all Tandem tools (each one that needs you shows its own card)
  ...['snapshot', 'navigate', 'navigate_back', 'take_screenshot', 'tabs', 'wait_for', 'console_messages',
    'network_requests', 'resize', 'close', 'install'].map((t) => `mcp__playwright__browser_${t}`),
];

export const isRunning = (chatId, botId) => active.has(`${chatId}:${botId}`);
export const runningIn = (chatId) => [...active.values()].filter((r) => r.chatId === chatId).map((r) => ({ botId: r.botId, status: r.status, id: r.id }));
export const runById = (id) => [...active.values()].find((r) => r.id === id);

function mcpConfig(runCtx) {
  const servers = {
    tandem: {
      command: process.execPath,
      args: [path.join(ROOT, 'mcp', 'tandem-mcp.js')],
      env: {
        TANDEM_URL: `http://127.0.0.1:${PORT}`,
        TANDEM_TOKEN: setting('access_token'),
        TANDEM_BOT: runCtx.botId, TANDEM_CHAT: runCtx.chatId, TANDEM_RUN: runCtx.id, TANDEM_ORIGIN: runCtx.origin,
        TANDEM_DEPTH: String(runCtx.opts.depth || 0), TANDEM_PREAPPROVED: runCtx.opts.preapproved ? '1' : '0',
      },
    },
    playwright: {
      command: process.execPath,
      args: [path.join(ROOT, 'node_modules', '@playwright', 'mcp', 'cli.js'), '--cdp-endpoint', computer.CDP_URL, '--output-dir', path.join(PATHS.workspace, '.browser')],
    },
    ...connectors.customMcpServers(),
  };
  const file = path.join(PATHS.runtime, `mcp-${runCtx.id}.json`);
  fs.writeFileSync(file, JSON.stringify({ mcpServers: servers }));
  return file;
}

function toolStatus(name, input) {
  if (name.startsWith('mcp__playwright__browser_')) return approvals.describe(name, input).replace(/^Click/, 'Clicking').replace(/^Type/, 'Typing') ||
    'Using the browser';
  if (name === 'Bash' && input.description) return input.description.replace(/\.$/, '');
  const map = { Bash: 'Running a command', Read: 'Reading files', Write: 'Writing a file', Edit: 'Editing a file', Grep: 'Searching files', Glob: 'Looking for files', WebSearch: 'Searching the web', WebFetch: 'Reading a web page' };
  if (map[name]) return map[name];
  if (name === 'mcp__playwright__browser_navigate') return `Opening ${input.url}`;
  return name.replace(/^mcp__(tandem|app_\w+)__/, '').replace(/_/g, ' ');
}

// Group chats: show each Bot what happened since its last turn there.
function groupTranscript(chat, botId) {
  const msgs = chats.messages(chat.id, { limit: 60 });
  let lastMine = -1;
  msgs.forEach((m, i) => { if (m.bot_id === botId && m.author === 'bot') lastMine = i; });
  const fresh = msgs.slice(lastMine + 1).filter((m) => m.text && !(m.author === 'bot' && m.bot_id === botId));
  return fresh.map((m) => {
    const who = m.author === 'user' ? 'User' : m.author === 'system' ? 'System' : chats.getBot(m.bot_id)?.name || 'Bot';
    return `${who}: ${m.text}`;
  }).join('\n');
}

/**
 * Run one turn of a Bot in a chat.
 * opts: { origin: 'chat'|'routine'|'handoff'|'system', attachments, replyTo, depth, preapproved, parentId }
 */
export function runBot(botId, chatId, text, opts = {}) {
  const key = `${chatId}:${botId}`;
  const origin = opts.origin || 'chat';
  const current = active.get(key);
  if (current) {
    if (origin === 'chat') {
      // A direct message from you takes priority and redirects the current turn.
      stop(current.id, { silent: true });
      text = `[New message from the user while you were working — it takes priority. Continue from where you stopped if still relevant.]\n${text}`;
    } else {
      const prev = queues.get(key) || Promise.resolve();
      const p = prev.then(() => waitFor(key)).then(() => runBot(botId, chatId, text, opts));
      queues.set(key, p.catch(() => {}));
      return p;
    }
  }
  return start(botId, chatId, text, { ...opts, origin });
}

function waitFor(key) {
  const r = active.get(key);
  return r ? r.done : Promise.resolve();
}

function start(botId, chatId, text, opts) {
  const bot = chats.getBot(botId);
  const chat = chats.getChat(chatId);
  if (!bot || !chat) return Promise.resolve({ error: 'Bot or chat not found' });
  const id = uid('run_');
  const model = opts.model || pickModel(text, { origin: opts.origin, attachments: (opts.attachments || []).length });
  const runCtx = { id, botId, chatId, origin: opts.origin, model, status: 'Thinking', started: now(), messageId: null, text: '', opts, steps: [], tail: [] };
  const key = `${chatId}:${botId}`;

  let fullText = text;
  if (chat.kind === 'group' && opts.origin === 'chat') {
    fullText = `[Group chat "${chat.name}" — new messages since your last turn]\n${groupTranscript(chat, botId)}`;
  }
  if (opts.attachments?.length) {
    fullText += `\n\nAttached files (read them with the Read tool):\n${opts.attachments.map((a) => `- ${a.path} (${a.name})`).join('\n')}`;
  }

  const sid = chats.sessionFor(chatId, botId);
  const newSid = sid ? null : crypto.randomUUID();
  const mcpFile = mcpConfig(runCtx);
  const args = [
    '-p', fullText,
    '--output-format', 'stream-json', '--verbose',
    '--model', model,
    '--append-system-prompt', prompt.build(bot, chat, { origin: opts.origin }),
    '--mcp-config', mcpFile, '--strict-mcp-config',
    '--setting-sources', '',
    '--permission-mode', 'acceptEdits',
    '--permission-prompt-tool', 'mcp__tandem__approval_prompt',
    '--allowedTools', ...READ_ONLY_TOOLS,
    '--add-dir', PATHS.uploads,
    ...(sid ? ['--resume', sid] : ['--session-id', newSid]),
  ];
  if (newSid) chats.setSession(chatId, botId, newSid);

  const child = spawn(CLAUDE_BIN, args, {
    cwd: PATHS.workspace,
    env: childEnv({ MCP_TOOL_TIMEOUT: String(6 * 3600 * 1000), MCP_TIMEOUT: '60000', BASH_DEFAULT_TIMEOUT_MS: '600000' }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  runCtx.child = child;
  let resolveDone;
  runCtx.done = new Promise((r) => (resolveDone = r));
  active.set(key, runCtx);
  emit('run', publicRun(runCtx));

  let buf = '', stderr = '', resultEvt = null;
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let evt; try { evt = JSON.parse(line); } catch { continue; }
      handleEvent(evt);
    }
  });
  child.stderr.on('data', (d) => (stderr += d));

  function setStatus(s) { runCtx.status = s; emit('run', publicRun(runCtx)); }

  function handleEvent(evt) {
    if (evt.type === 'system' && evt.subtype === 'init' && evt.session_id) {
      chats.setSession(chatId, botId, evt.session_id);
    } else if (evt.type === 'assistant') {
      for (const block of evt.message?.content || []) {
        if (block.type === 'text' && block.text.trim()) {
          const t = block.text.trim();
          runCtx.steps.push({ k: 'text', t });
          runCtx.tail.push(t);
          setStatus(t.split('\n')[0].slice(0, 120));
        } else if (block.type === 'tool_use') {
          const label = toolStatus(block.name, block.input || {});
          runCtx.steps.push({ k: 'tool', t: label });
          runCtx.tail = [];
          setStatus(label);
        } else if (block.type === 'thinking') setStatus('Thinking');
      }
    } else if (evt.type === 'result') {
      resultEvt = evt;
    }
  }

  // One message per turn: the final answer, with the work that led to it folded into steps.
  function postFinal(finalText) {
    const t = (finalText || '').trim();
    if (!t || (chat.kind === 'group' && /^PASS\.?$/i.test(t))) return;
    const tailSet = new Set(runCtx.tail);
    const steps = runCtx.steps.filter((x) => !(x.k === 'text' && (tailSet.has(x.t) || t.includes(x.t))))
      .slice(-80).map((x) => ({ k: x.k, t: x.t.slice(0, 600) }));
    runCtx.text = t;
    const m = chats.addMessage({ chatId, author: 'bot', botId, text: t, parentId: opts.parentId || null,
      meta: { runId: id, model, origin: opts.origin, steps, duration: now() - runCtx.started } });
    runCtx.messageId = m.id;
  }

  child.on('close', (code) => {
    if (active.get(key) === runCtx) active.delete(key);
    try { fs.unlinkSync(mcpFile); } catch {}
    approvals.cancelFor(id);
    let error = null;
    if (resultEvt) {
      const u = resultEvt.usage || {};
      sql('INSERT INTO usage (id, bot_id, model, cost, input_tokens, output_tokens, origin, created) VALUES (?,?,?,?,?,?,?,?)',
        uid('u_'), botId, model, resultEvt.total_cost_usd || 0,
        (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0), u.output_tokens || 0, opts.origin, now());
      if (resultEvt.is_error) error = resultEvt.result || resultEvt.subtype || 'Run failed';
      else postFinal(resultEvt.result || runCtx.tail.join('\n\n'));
    } else if (!runCtx.stopped) {
      error = stderr.trim().split('\n').slice(-3).join(' ') || `Claude Code exited with code ${code}`;
    }
    if (error && /No conversation found|session.*not found/i.test(error + stderr) && !opts._retried) {
      sql('DELETE FROM chat_sessions WHERE chat_id = ? AND bot_id = ?', chatId, botId);
      runCtx.status = 'done'; emit('run', { ...publicRun(runCtx), ended: true });
      start(botId, chatId, text, { ...opts, _retried: true }).then(resolveDone);
      return;
    }
    if (error && !runCtx.stopped) {
      chats.addMessage({ chatId, author: 'system', botId, text: `${bot.name} hit a problem: ${error}`, meta: { error: true } });
    }
    if (!resultEvt && runCtx.stopped && runCtx.tail.length) postFinal(runCtx.tail.join('\n\n'));
    if (runCtx.stopped && !runCtx.silentStop) chats.addMessage({ chatId, author: 'system', botId, text: `${bot.name} stopped. Work already done isn't undone.` });
    runCtx.status = 'done';
    emit('run', { ...publicRun(runCtx), ended: true });
    if (runCtx.text && bot.notify && opts.origin !== 'chat') emit('notify', { botId, chatId, title: bot.name, body: runCtx.text.slice(0, 140) });
    // Bot-to-bot: the reply lands back where the handoff came from.
    if (opts.replyTo && runCtx.text && !error) deliverReply(botId, opts.replyTo, runCtx.text, opts.depth || 0);
    resolveDone({ error, text: runCtx.text, messageId: runCtx.messageId });
  });

  return runCtx.done;
}

export function stop(runId, { silent = false } = {}) {
  const r = runById(runId);
  if (!r) return false;
  r.stopped = true;
  r.silentStop = silent;
  approvals.cancelFor(runId);
  r.child.kill('SIGTERM');
  setTimeout(() => { try { r.child.kill('SIGKILL'); } catch {} }, 4000);
  return true;
}

export function stopChat(chatId) {
  for (const r of active.values()) if (r.chatId === chatId) stop(r.id);
}

const publicRun = (r) => ({ id: r.id, botId: r.botId, chatId: r.chatId, status: r.status, model: r.model, origin: r.origin, started: r.started, steps: r.steps?.length || 0 });
export const activeRuns = () => [...active.values()].map(publicRun);

// ---- Entry points -------------------------------------------------------------------

export function runInDm(botId, text, opts = {}) {
  const dm = chats.dmFor(botId);
  return runBot(botId, dm.id, text, opts);
}

// A message you posted. DMs go to the Bot; groups go to mentioned Bots, @everyone,
// or the Bots that decide it's for them.
export async function onUserMessage(chatId, msg) {
  const chat = chats.getChat(chatId);
  const opts = { origin: 'chat', attachments: msg.attachments || [], parentId: msg.parent_id || null };
  let text = msg.text;
  if (msg.parent_id) {
    const parent = chats.getMessage(msg.parent_id);
    if (parent) text = `[Replying in a thread to: "${(parent.text || parent.card?.summary || '').slice(0, 400)}"]\n${text}`;
  }
  if (chat.kind === 'dm') return runBot(chat.bot_ids[0], chatId, text, opts);

  const members = chat.bot_ids.map(chats.getBot).filter(Boolean);
  let targets;
  if (/@everyone\b/i.test(text)) targets = members;
  else {
    targets = members.filter((b) => new RegExp(`@${b.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text));
    if (!targets.length) targets = await triage(members, text);
  }
  return Promise.all(targets.map((b) => runBot(b.id, chatId, text, opts)));
}

async function triage(members, text) {
  try {
    const roster = members.map((b) => {
      const facts = memory.recall(b.id).bot.facts.slice(0, 6).map((f) => f.text).join('; ');
      return `- ${b.name}${b.label ? ` (${b.label})` : ''}: ${facts || 'no job saved yet'}`;
    }).join('\n');
    const j = await quickJson(`Group chat members:\n${roster}\n\nNew message from the user: "${text}"\n\n` +
      'Which members should respond? Usually one owner. Reply JSON only: {"responders":["Name"]}',
    { system: 'You route messages in a team chat to the right teammate(s).' });
    const picked = members.filter((b) => (j.responders || []).some((n) => n.toLowerCase() === b.name.toLowerCase()));
    if (picked.length) return picked;
  } catch {}
  return [members[0]];
}

// ---- Bot-to-bot handoff -------------------------------------------------------------

export function handoff({ fromBot, fromChat, to, text, expectReply = true, depth = 0 }) {
  const target = chats.findBot(to);
  if (!target) throw new Error(`No Bot named ${to}`);
  if (target.id === fromBot) throw new Error("You can't hand off to yourself");
  if (depth > 4) throw new Error('Too many handoffs in a row; finish the work or ask the user.');
  const sender = chats.getBot(fromBot);
  const dm = chats.dmFor(target.id);
  chats.addMessage({ chatId: fromChat, author: 'system', botId: fromBot, text: `${sender.name} → ${target.name}: ${text}`, meta: { handoff: true, to: target.id } });
  chats.addMessage({ chatId: dm.id, author: 'bot', botId: fromBot, text, meta: { handoff: true, to: target.id, fromChat } });
  runBot(target.id, dm.id, `Message from ${sender.name} (another of the user's Bots):\n${text}` +
    (expectReply ? `\n\nYour final reply will be sent back to ${sender.name}.` : ''),
  { origin: 'handoff', replyTo: expectReply ? { botId: fromBot, chatId: fromChat } : null, depth: depth + 1 });
  return { delivered: true, to: target.name };
}

function deliverReply(fromBotId, replyTo, text, depth) {
  const from = chats.getBot(fromBotId);
  chats.addMessage({ chatId: replyTo.chatId, author: 'system', botId: fromBotId, text: `${from.name} replied: ${text.slice(0, 1500)}`, meta: { handoff: true } });
  runBot(replyTo.botId, replyTo.chatId, `Reply from ${from.name}:\n${text}`, { origin: 'handoff', depth });
}
