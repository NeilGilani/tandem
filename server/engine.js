// Runs Bots. Each turn is a headless Claude Code run (`claude -p`, stream-json) that
// resumes that Bot's session for that conversation, with the Tandem tools, the
// shared browser (Playwright MCP over CDP) and any custom MCP apps attached.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROOT, PATHS, uid, now, run as sql, get as sqlGet, setting } from './db.js';
import { CLAUDE_BIN, childEnv, quickJson } from './claude.js';
import { emit } from './bus.js';
import { pickModel } from './router.js';
import * as chats from './chats.js';
import * as prompt from './prompt.js';
import * as approvals from './approvals.js';
import * as connectors from './connectors.js';
import * as computer from './computer.js';
import * as memory from './memory.js';
import * as activity from './activity.js';

export let PORT = 4747;
export const setPort = (p) => { PORT = p; };

const STALL_MS = Number(process.env.TANDEM_STALL_MS) || 20 * 60e3; // longer than the 10-minute command timeout
const active = new Map(); // `${chatId}:${botId}` -> run
const queues = new Map(); // same key -> promise chain for background work

const READ_ONLY_TOOLS = [
  'Read', 'Glob', 'Grep', 'LS', 'WebSearch', 'WebFetch', 'TodoWrite', 'Task', 'Agent', 'BashOutput', 'NotebookRead',
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
        TANDEM_DEPTH: String(runCtx.opts.depth || 0), TANDEM_PREAPPROVED: runCtx.opts.preapproved ? '1' : '0', TANDEM_MISSION: runCtx.missionId || '',
      },
    },
    playwright: {
      command: process.execPath,
      args: [path.join(ROOT, 'node_modules', '@playwright', 'mcp', 'cli.js'), '--cdp-endpoint', computer.cdpUrl(runCtx.botId), '--output-dir', path.join(computer.workspaceOf(runCtx.botId), '.browser')],
    },
    ...connectors.customMcpServers(),
  };
  const file = path.join(PATHS.runtime, `mcp-${runCtx.id}.json`);
  fs.writeFileSync(file, JSON.stringify({ mcpServers: servers }));
  return file;
}

const HIDDEN_TOOLS = new Set(['ToolSearch', 'TodoWrite', 'TodoRead', 'ExitPlanMode', 'mcp__tandem__approval_prompt']);
const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };
const BROWSER_STATUS = {
  snapshot: 'Reading the page', take_screenshot: 'Looking at the screen', wait_for: 'Waiting for the page', tabs: 'Switching tabs',
  navigate_back: 'Going back', console_messages: 'Checking the page', network_requests: 'Checking the page', resize: 'Resizing the window',
  close: 'Closing the page', install: 'Setting up the browser', press_key: 'Pressing a key', hover: 'Pointing at something',
};
function toolStatus(name, input) {
  if (name.startsWith('mcp__playwright__browser_')) {
    const t = name.replace('mcp__playwright__browser_', '');
    if (t === 'navigate') return `Opening ${host(input.url)}`;
    if (t === 'click') return `Clicking ${input.element || 'a button'}`;
    if (t === 'type') return `Typing into ${input.element || 'a field'}`;
    if (t === 'fill_form') return 'Filling in a form';
    return BROWSER_STATUS[t] || 'Using the browser';
  }
  const tandem = { remember: 'Updating memory', recall: 'Checking memory', log_work: 'Logging work', message_bot: 'Messaging another Bot', get_skill: 'Loading a skill',
    save_skill: 'Saving a skill', create_routine: 'Setting up a routine', draft_message: 'Drafting', ask_user: 'Asking you', request_connect: 'Waiting for you to connect an app',
    request_takeover: 'Waiting for you', vault_fill_login: 'Signing in', add_to_library: 'Saving to your Library', list_connectors: 'Checking connected apps' };
  const tn = name.replace(/^mcp__tandem__/, '');
  if (tn === 'site_fetch' && name.startsWith('mcp__tandem__')) return `Pulling data from ${host(input.url || '')}`;
  if (name.startsWith('mcp__tandem__') && tandem[tn]) return tandem[tn];
  if (name === 'Bash' && input.description) return input.description.replace(/\.$/, '');
  if (name === 'Skill') return `Loading know-how${input.skill ? `: ${String(input.skill).replace(/[-_]/g, ' ')}` : ''}`;
  if ((name === 'Agent' || name === 'Task') && input.description) return `Side task: ${input.description.replace(/\.$/, '')}`;
  const map = { Bash: 'Running a command', Read: 'Reading files', Write: 'Writing a file', Edit: 'Editing a file', Grep: 'Searching files', Glob: 'Looking for files', WebSearch: 'Searching the web', WebFetch: 'Reading a web page' };
  if (map[name]) return map[name];
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
  const key = `${opts.sessionKey || chatId}:${botId}`;
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

// The Claude Code flags for a turn (everything but the prompt itself).
function runArgs(bot, chat, runCtx, sessKey) {
  const sid = chats.sessionFor(sessKey, bot.id);
  const newSid = sid ? null : crypto.randomUUID();
  const mcpFile = mcpConfig(runCtx);
  const args = [
    '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--model', runCtx.model,
    '--append-system-prompt', prompt.build(bot, chat, { origin: runCtx.origin }),
    '--mcp-config', mcpFile, '--strict-mcp-config',
    '--setting-sources', '',
    '--permission-mode', 'acceptEdits',
    '--permission-prompt-tool', 'mcp__tandem__approval_prompt',
    '--allowedTools', ...READ_ONLY_TOOLS,
    '--add-dir', PATHS.uploads, '--add-dir', PATHS.shared,
    ...(sid ? ['--resume', sid] : ['--session-id', newSid]),
  ];
  return { args, mcpFile, sid, newSid };
}
const CHILD_ENV = () => childEnv({ MCP_TOOL_TIMEOUT: String(6 * 3600 * 1000), MCP_TIMEOUT: '60000', BASH_DEFAULT_TIMEOUT_MS: '600000' });

// ---- Instant start ------------------------------------------------------------------
// While you type to a Bot, its browser wakes and a Claude Code session starts and waits
// for your message, so work begins the moment you send instead of ~5 seconds later.
const warmPool = new Map(); // key -> { id, child, model, sid, newSid, mcpFile, pre, timer }
const WARM_TTL = 75e3;

export function warm(chatId) {
  const chat = chats.getChat(chatId);
  if (!chat || chat.kind !== 'dm') return false;
  const botId = chat.bot_ids[0];
  const bot = chats.getBot(botId);
  const key = `${chatId}:${botId}`;
  if (!bot || active.has(key)) return false;
  const existing = warmPool.get(key);
  if (existing) { clearTimeout(existing.timer); existing.timer = setTimeout(() => dropWarm(key), WARM_TTL); return true; }
  if (warmPool.size >= 3) dropWarm(warmPool.keys().next().value);
  const id = uid('run_');
  const model = pickModel('', { origin: 'chat' });
  const ctx = { id, botId, chatId, missionId: null, origin: 'chat', model, opts: {} };
  const { args, mcpFile, sid, newSid } = runArgs(bot, chat, ctx, chatId);
  const entry = { id, model, sid, newSid, mcpFile, pre: [], child: null, timer: null };
  warmPool.set(key, entry);
  computer.ensureBrowser(botId).catch(() => {});
  const child = spawn(CLAUDE_BIN, ['-p', '--input-format', 'stream-json', ...args], { cwd: computer.workspaceOf(botId), env: CHILD_ENV(), stdio: ['pipe', 'pipe', 'pipe'] });
  entry.child = child;
  entry.onData = (d) => entry.pre.push(d);
  child.stdout.on('data', entry.onData);
  child.on('close', () => { if (warmPool.get(key) === entry) { warmPool.delete(key); try { fs.unlinkSync(mcpFile); } catch {} } });
  entry.timer = setTimeout(() => dropWarm(key), WARM_TTL);
  return true;
}

function dropWarm(key) {
  const e = warmPool.get(key);
  if (!e) return;
  warmPool.delete(key);
  clearTimeout(e.timer);
  try { e.child.kill('SIGTERM'); } catch {}
  try { fs.unlinkSync(e.mcpFile); } catch {}
}

// A warm session can take this turn only if it was started exactly as this turn would be.
function takeWarm(key, { chatId, botId, model, opts }) {
  const e = warmPool.get(key);
  if (!e) return null;
  const fits = opts.origin === 'chat' && !opts.sessionKey && !opts.depth && !opts.preapproved && !opts.missionId && !opts.model
    && e.model === model && chats.sessionFor(chatId, botId) === e.sid && e.child.exitCode === null;
  warmPool.delete(key);
  clearTimeout(e.timer);
  if (!fits) { try { e.child.kill('SIGTERM'); } catch {} try { fs.unlinkSync(e.mcpFile); } catch {} return null; }
  return e;
}

function start(botId, chatId, text, opts) {
  const bot = chats.getBot(botId);
  const chat = chats.getChat(chatId);
  if (!bot || !chat) return Promise.resolve({ error: 'Bot or chat not found' });
  const model = opts.model || pickModel(text, { origin: opts.origin, attachments: (opts.attachments || []).length });
  const key = `${opts.sessionKey || chatId}:${botId}`;
  const warmed = takeWarm(key, { chatId, botId, model, opts });
  const id = warmed?.id || uid('run_');
  const runCtx = { id, botId, chatId, missionId: opts.missionId || null, origin: opts.origin, model, status: 'Thinking', started: now(), messageId: null, text: '', opts, steps: [], tail: [], toolActs: new Map(), trail: [], live: '', warm: !!warmed, writes: new Set(), hosts: new Set() };

  let fullText = text;
  if (chat.kind === 'group' && opts.origin === 'chat') {
    fullText = `[Group chat "${chat.name}" — new messages since your last turn]\n${groupTranscript(chat, botId)}`;
  }
  if (opts.attachments?.length) {
    fullText += `\n\nAttached files (read them with the Read tool):\n${opts.attachments.map((a) => `- ${a.path} (${a.name})`).join('\n')}`;
  }

  // Missions keep their own conversation, separate from your chat with the Bot.
  const sessKey = opts.sessionKey || chatId;
  let mcpFile, args = null, newSid;
  if (warmed) ({ mcpFile, newSid } = warmed);
  else { const r = runArgs(bot, chat, runCtx, sessKey); mcpFile = r.mcpFile; newSid = r.newSid; args = ['-p', fullText, ...r.args]; }
  if (newSid) chats.setSession(sessKey, botId, newSid);

  let resolveDone;
  runCtx.done = new Promise((r) => (resolveDone = r));
  active.set(key, runCtx);
  runCtx.runAct = activity.log({ runId: id, botId, chatId, kind: 'run', summary: opts.origin === 'routine' ? text.split(':')[0] : opts.origin === 'handoff' ? 'Picked up a handoff' : `Started: ${text.replace(/^\[[^\]]*\]\s*/, '').slice(0, 120)}`, status: 'running', origin: opts.origin });
  runCtx.status = 'Starting its computer';
  emit('run', publicRun(runCtx));
  // Each Bot has its own computer; make sure its browser is up before Claude Code starts.
  computer.ensureBrowser(botId).catch((e) => console.error('computer', botId, e.message)).then(() => {
    if (runCtx.stopped) {
      if (active.get(key) === runCtx) active.delete(key);
      emit('run', { ...publicRun(runCtx), ended: true });
      resolveDone({ error: null });
      return;
    }
    runCtx.status = 'Thinking';
    emit('run', publicRun(runCtx));
    launch();
  });
  return runCtx.done;

  function launch() {
  const child = warmed ? warmed.child : spawn(CLAUDE_BIN, args, { cwd: computer.workspaceOf(botId), env: CHILD_ENV(), stdio: ['ignore', 'pipe', 'pipe'] });
  runCtx.child = child;

  let buf = '', stderr = '', resultEvt = null;
  // Watchdog: a step that hangs with no progress (and isn't waiting on you) gets restarted,
  // and the Bot picks up where it left off.
  runCtx.lastEvent = now();
  const watchdog = setInterval(() => {
    if (now() - runCtx.lastEvent < STALL_MS || runCtx.stopped) return;
    const waitingOnYou = sqlGet(`SELECT 1 AS x FROM messages WHERE chat_id = ? AND bot_id = ? AND card LIKE '%"status":"pending"%' LIMIT 1`, chatId, botId);
    if (waitingOnYou) { runCtx.lastEvent = now(); return; }
    runCtx.stalled = true;
    clearInterval(watchdog);
    child.kill('SIGTERM');
    setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 4000);
  }, Math.min(60e3, STALL_MS / 4));
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
  if (warmed) {
    child.stdout.off('data', warmed.onData);
    for (const d of warmed.pre) child.stdout.emit('data', d);
    child.stdin.end(JSON.stringify({ type: 'user', message: { role: 'user', content: fullText } }) + '\n');
  }

  // Keep a recent screenshot of the computer for the in-chat Computer card.
  let shotTimer = null;
  function snapshotSoon() {
    if (shotTimer) return;
    shotTimer = setTimeout(async () => {
      shotTimer = null;
      try {
        const shot = await computer.screenshot(botId, 60);
        if (!shot) return;
        const dir = path.join(PATHS.uploads, 'shots');
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, `${id}.jpg`);
        fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
        runCtx.lastShot = file;
      } catch {}
    }, 2500);
  }

  function setStatus(s) { runCtx.status = s; emit('run', publicRun(runCtx)); }

  // Live view: the text being written right now, and a trail of steps with timings.
  let pushTimer = null;
  function pushLive() {
    if (pushTimer) return;
    pushTimer = setTimeout(() => { pushTimer = null; emit('run', publicRun(runCtx)); }, 70);
  }
  function handleEvent(evt) {
    // Heartbeats while a tool runs aren't progress; everything else is.
    if (evt.type !== 'tool_progress' && !(evt.type === 'system' && evt.subtype === 'status')) runCtx.lastEvent = now();
    if (evt.type === 'stream_event') {
      const e = evt.event || {};
      if (evt.parent_tool_use_id) return; // a sub-agent's stream; the trail covers it
      if (e.type === 'content_block_start' && e.content_block?.type === 'text') { runCtx.live = ''; pushLive(); }
      else if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta') { runCtx.live += e.delta.text; pushLive(); }
      else if (e.type === 'content_block_start' && e.content_block?.type === 'thinking') { runCtx.status = 'Thinking'; pushLive(); }
      return;
    }
    if (evt.type === 'system' && evt.subtype === 'init' && evt.session_id) {
      chats.setSession(sessKey, botId, evt.session_id);
    } else if (evt.type === 'assistant') {
      for (const block of evt.message?.content || []) {
        if (block.type === 'text' && block.text.trim()) {
          const t = block.text.trim();
          runCtx.steps.push({ k: 'text', t });
          runCtx.tail.push(t);
          setStatus(t.split('\n')[0].slice(0, 120));
        } else if (block.type === 'tool_use') {
          // Claude Code's own housekeeping isn't work the user cares to see.
          if (HIDDEN_TOOLS.has(block.name)) { setStatus('Getting ready'); continue; }
          if (block.name.startsWith('mcp__playwright__')) { runCtx.browser = true; snapshotSoon(); }
          const inp = block.input || {};
          if (/^(Write|Edit|MultiEdit|NotebookEdit)$/.test(block.name) && (inp.file_path || inp.notebook_path)) runCtx.writes.add(inp.file_path || inp.notebook_path);
          if (inp.url && /^https?:/.test(inp.url)) runCtx.hosts.add(host(inp.url));
          const label = toolStatus(block.name, block.input || {});
          runCtx.steps.push({ k: 'tool', t: label });
          runCtx.tail = [];
          setStatus(label);
          if (runCtx.live.trim()) { runCtx.trail.push({ k: 'note', t: runCtx.live.trim().slice(0, 400) }); }
          runCtx.live = '';
          runCtx.trail.push({ id: block.id, k: 'tool', t: label, s: 'run', at: now() });
          if (block.name !== 'mcp__tandem__approval_prompt') {
            const detail = block.name === 'Bash' ? block.input?.command : block.input?.url || block.input?.element || null;
            runCtx.toolActs.set(block.id, activity.log({ runId: id, botId, chatId, kind: 'tool', tool: block.name, summary: label, detail, status: 'running', origin: opts.origin }));
          }
        } else if (block.type === 'thinking') setStatus('Thinking');
      }
    } else if (evt.type === 'user') {
      for (const block of evt.message?.content || []) {
        if (block.type !== 'tool_result') continue;
        const step = runCtx.trail.find((x) => x.id === block.tool_use_id);
        if (step) { step.s = block.is_error ? 'err' : 'ok'; step.ms = now() - step.at; pushLive(); }
        const actId = runCtx.toolActs.get(block.tool_use_id);
        if (!actId) continue;
        const txt = Array.isArray(block.content) ? block.content.map((c) => c.text || '').join(' ') : String(block.content || '');
        const denied = /denied this action|set to Never allow/i.test(txt);
        activity.finish(actId, denied ? 'denied' : block.is_error ? 'error' : 'ok', block.is_error || denied ? txt.slice(0, 600) : null);
      }
    } else if (evt.type === 'rate_limit_event') {
      runCtx.rate = evt.rate_limit_info;
      activity.recordPlan(evt.rate_limit_info);
    } else if (evt.type === 'result') {
      resultEvt = evt;
    }
  }

  // One message per turn: the final answer, with the work that led to it folded into steps.
  function postFinal(finalText) {
    const t = (finalText || '').trim();
    if (!t || (chat.kind === 'group' && /^PASS\.?$/i.test(t))) return;
    if (opts.origin === 'squad') { runCtx.text = t; return; } // a helper's report goes to its lead, not the chat
    let shot = null;
    if (runCtx.browser && runCtx.lastShot) shot = runCtx.lastShot;
    const tailSet = new Set(runCtx.tail);
    const steps = runCtx.steps.filter((x) => !(x.k === 'text' && (tailSet.has(x.t) || t.includes(x.t))))
      .slice(-80).map((x) => ({ k: x.k, t: x.t.slice(0, 600) }));
    runCtx.text = t;
    const m = chats.addMessage({ chatId, author: 'bot', botId, text: t, parentId: opts.parentId || null,
      meta: { runId: id, model, origin: opts.origin, steps, duration: now() - runCtx.started, browser: !!runCtx.browser, shot,
        files: producedFiles(botId, runCtx), sites: [...runCtx.hosts].filter(Boolean).slice(0, 12) } });
    runCtx.messageId = m.id;
    if ((opts.origin === 'chat' || opts.origin === 'system') && chat.kind === 'dm' && !/^\[Voice call\]/.test(text)) suggestNext(m, text, t);
  }

  child.on('close', (code) => {
    clearInterval(watchdog);
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
    } else if (runCtx.stalled) {
      error = `A step hung with no progress for ${STALL_MS / 60e3} minutes`;
    } else if (!runCtx.stopped) {
      error = stderr.trim().split('\n').slice(-3).join(' ') || `Claude Code exited with code ${code}`;
    }
    if (error && /No conversation found|session.*not found/i.test(error + stderr) && !opts._retried) {
      sql('DELETE FROM chat_sessions WHERE chat_id = ? AND bot_id = ?', sessKey, botId);
      runCtx.status = 'done'; emit('run', { ...publicRun(runCtx), ended: true });
      start(botId, chatId, text, { ...opts, _retried: true }).then(resolveDone);
      return;
    }
    for (const actId of runCtx.toolActs.values()) activity.finish(actId, runCtx.stopped ? 'stopped' : error ? 'error' : 'ok');
    if (error && !runCtx.stopped) {
      const errText = `${error} ${stderr}`;
      const limited = /usage limit|rate.?limit|limit reached|429|quota/i.test(errText) || (runCtx.rate && runCtx.rate.status && runCtx.rate.status !== 'allowed');
      const transient = runCtx.stalled || /overloaded|529|5\d\d|timeout|timed out|ECONN|EPIPE|socket hang up|network|exited with code|terminated|Internal server error/i.test(errText);
      const tries = opts._resumes || 0;
      activity.log({ runId: id, botId, chatId, kind: 'error', summary: limited ? 'Paused: Claude plan limit' : 'Run interrupted', detail: error, status: 'error', origin: opts.origin });
      if (limited) {
        const until = (runCtx.rate?.resetsAt ? runCtx.rate.resetsAt * 1000 : activity.plan()?.resetsAt) || now() + 30 * 60e3;
        const wait = Math.min(Math.max(until - now() + 60e3, 60e3), 6 * 3600e3);
        chats.addMessage({ chatId, author: 'system', botId, text: `${bot.name} paused: your Claude plan limit is reached. It picks this back up at ${new Date(now() + wait).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.`, meta: { kind: 'paused' } });
        setTimeout(() => resume(botId, chatId, opts, 'Your plan limit has reset.'), wait);
      } else if (transient && tries < 2) {
        const wait = tries === 0 ? 20e3 : 90e3;
        chats.addMessage({ chatId, author: 'system', botId, text: `${bot.name} was interrupted and will pick up where it left off.`, meta: { kind: 'resuming' } });
        setTimeout(() => resume(botId, chatId, { ...opts, _resumes: tries + 1 }, `Your previous attempt was interrupted by an error (${String(error).slice(0, 200)}).`), wait);
      } else {
        chats.addMessage({ chatId, author: 'system', botId, text: `${bot.name} hit a problem: ${error}`, meta: { error: true } });
      }
    }
    if (!resultEvt && runCtx.stopped && runCtx.tail.length) postFinal(runCtx.tail.join('\n\n'));
    if (runCtx.stopped && !runCtx.silentStop) chats.addMessage({ chatId, author: 'system', botId, text: `${bot.name} stopped. Work already done isn't undone.` });
    runCtx.status = 'done';
    emit('run', { ...publicRun(runCtx), ended: true });
    if (runCtx.text && bot.notify && opts.origin !== 'chat') emit('notify', { botId, chatId, title: bot.name, body: runCtx.text.slice(0, 140) });
    // Bot-to-bot: the reply lands back where the handoff came from.
    if (opts.replyTo && runCtx.text && !error) deliverReply(botId, opts.replyTo, runCtx.text, opts.depth || 0);
    computer.touch(botId);
    activity.finish(runCtx.runAct, runCtx.stopped ? 'stopped' : error ? 'error' : 'ok', runCtx.text ? runCtx.text.slice(0, 1500) : null);
    resolveDone({ error, text: runCtx.text, messageId: runCtx.messageId, shot: runCtx.browser ? runCtx.lastShot || null : null });
  });
  }
}

// Files a turn made or changed: what it wrote, plus anything new in its working folder.
const SKIP_DIRS = new Set(['node_modules', '__pycache__', 'venv', '.venv', 'site-packages']);
const KIND = (f) => /\.(png|jpe?g|gif|webp|svg)$/i.test(f) ? 'image' : /\.(csv|tsv|xlsx?)$/i.test(f) ? 'sheet' : /\.(md|txt|docx?|pdf|rtf)$/i.test(f) ? 'doc'
  : /\.(pptx?|key)$/i.test(f) ? 'slides' : /\.(html?)$/i.test(f) ? 'page' : /\.(json|js|ts|py|sh|css)$/i.test(f) ? 'code' : 'file';
function producedFiles(botId, runCtx) {
  const since = runCtx.started - 1000;
  const found = new Map();
  const add = (f) => { try { const st = fs.statSync(f); if (st.isFile() && st.mtimeMs >= since) found.set(f, { path: f, name: path.basename(f), size: st.size, kind: KIND(f), at: st.mtimeMs }); } catch {} };
  for (const f of runCtx.writes) add(f);
  const walk = (dir, depth) => {
    let list; try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of list) {
      if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
      const f = path.join(dir, e.name);
      if (e.isDirectory()) { if (depth < 3) walk(f, depth + 1); } else add(f);
    }
  };
  walk(computer.workspaceOf(botId), 0);
  return [...found.values()].filter((x) => !/\/(\.site|\.browser)\//.test(x.path)).sort((a, b) => b.at - a.at).slice(0, 8).map(({ at, ...x }) => x);
}

// Two or three tappable next steps under a Bot's answer (one small, cheap call).
async function suggestNext(msg, asked, answered) {
  try {
    const j = await quickJson(
      `The user asked their AI coworker: "${String(asked).replace(/^\[[^\]]*\]\s*/, '').slice(0, 600)}"\n\nIt replied: "${answered.slice(0, 1800)}"\n\n` +
      'Suggest 3 short follow-up requests the user would most likely send next, written as the user (imperative, max 7 words each, no punctuation at the end). ' +
      'Prefer concrete next actions (draft it, put it in a sheet, make it a weekly routine, send it, dig deeper on X). Reply JSON only: {"s":["…","…","…"]}',
      { system: 'You write crisp follow-up suggestions for a chat UI.', timeoutMs: 30000 });
    const list = (j.s || []).map((x) => String(x).trim()).filter((x) => x && x.length < 70).slice(0, 3);
    if (!list.length) return;
    const cur = chats.getMessage(msg.id);
    if (cur) chats.updateMessage(msg.id, { meta: { ...(cur.meta || {}), suggestions: list } });
  } catch {}
}

// Pick an interrupted task back up in the same session.
function resume(botId, chatId, opts, why) {
  if (!chats.getBot(botId) || !chats.getChat(chatId)) return;
  if (isRunning(chatId, botId)) return;
  runBot(botId, chatId, `[${why} Continue the task from where you stopped. First check what is already done, so you don't repeat any action like sending a message twice.]`,
    { ...opts, origin: opts.origin === 'chat' ? 'system' : opts.origin, attachments: [] });
}

export function stop(runId, { silent = false } = {}) {
  const r = runById(runId);
  if (!r) return false;
  r.stopped = true;
  r.silentStop = silent;
  approvals.cancelFor(runId);
  if (!r.child) return true; // still starting its computer; it won't launch
  r.child.kill('SIGTERM');
  setTimeout(() => { try { r.child.kill('SIGKILL'); } catch {} }, 4000);
  return true;
}

export function stopChat(chatId) {
  for (const r of active.values()) if (r.chatId === chatId) stop(r.id);
}

const publicRun = (r) => ({ id: r.id, botId: r.botId, chatId: r.chatId, missionId: r.missionId, squadId: r.opts?.squadId || null, status: r.status, model: r.model, origin: r.origin, started: r.started,
  steps: r.steps?.length || 0, browser: !!r.browser, live: (r.live || '').slice(-4000),
  trail: (r.trail || []).slice(-14).map(({ k, t, s, ms }) => ({ k, t, s, ms })), trailTotal: (r.trail || []).filter((x) => x.k === 'tool').length });
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
  let text = msg.meta?.voice ? `[Voice call] ${msg.text}` : msg.text;
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
  activity.log({ botId: fromBot, chatId: fromChat, kind: 'handoff', summary: `Handed work to ${target.name}`, detail: text, status: 'ok' });
  chats.addMessage({ chatId: fromChat, author: 'system', botId: fromBot, text: `Sending to ${target.name}`, meta: { kind: 'handoff', from: fromBot, to: target.id, detail: text } });
  chats.addMessage({ chatId: dm.id, author: 'bot', botId: fromBot, text, meta: { handoff: true, to: target.id, fromChat } });
  runBot(target.id, dm.id, `Message from ${sender.name} (another of the user's Bots):\n${text}` +
    (expectReply ? `\n\nYour final reply will be sent back to ${sender.name}.` : ''),
  { origin: 'handoff', replyTo: expectReply ? { botId: fromBot, chatId: fromChat } : null, depth: depth + 1 });
  return { delivered: true, to: target.name };
}

function deliverReply(fromBotId, replyTo, text, depth) {
  const from = chats.getBot(fromBotId);
  chats.addMessage({ chatId: replyTo.chatId, author: 'system', botId: fromBotId, text: `Message from ${from.name}`, meta: { kind: 'handoff-reply', from: fromBotId, detail: text.slice(0, 4000) } });
  runBot(replyTo.botId, replyTo.chatId, `Reply from ${from.name}:\n${text}`, { origin: 'handoff', depth });
}
