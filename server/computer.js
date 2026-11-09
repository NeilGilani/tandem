// Computers: every Bot has its own. A computer is a Chrome instance with its own
// profile (so its own sign-ins) and its own workspace folder; a Shared folder is
// readable and writable by every Bot. Bots drive their browser through Playwright
// MCP over CDP. This module launches browsers on demand (minimized, so they don't
// cover your screen), streams screenshots, forwards your input when you take
// control, checks sign-in cookies, records Teach mode, and closes idle browsers.
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { PATHS, uid, get, all, run } from './db.js';
import { emit } from './bus.js';

const BASE_PORT = Number(process.env.TANDEM_CDP_PORT || 9400);
const IDLE_MS = 15 * 60 * 1000;

const CHROME_CANDIDATES = [
  process.env.TANDEM_CHROME,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);

const machines = new Map(); // botId -> machine

function portFor(botId) {
  const row = get('SELECT cdp_port FROM bots WHERE id = ?', botId);
  if (row?.cdp_port) return row.cdp_port;
  const used = new Set(all('SELECT cdp_port FROM bots WHERE cdp_port IS NOT NULL').map((r) => r.cdp_port));
  let p = BASE_PORT;
  while (used.has(p)) p++;
  run('UPDATE bots SET cdp_port = ? WHERE id = ?', p, botId);
  return p;
}

export function machine(botId) {
  if (!botId) throw new Error('No Bot given for the computer');
  let m = machines.get(botId);
  if (m) return m;
  const dir = path.join(PATHS.computers, botId);
  m = {
    botId,
    port: portFor(botId),
    dir,
    profile: path.join(dir, 'chrome-profile'),
    workspace: path.join(dir, 'workspace'),
    pid: null,
    control: 'bot', // 'bot' | 'user'
    takeover: null,
    teach: null,
    activity: '',
    lastUsed: Date.now(),
    waiters: new Set(),
  };
  fs.mkdirSync(m.workspace, { recursive: true });
  machines.set(botId, m);
  return m;
}

export const workspaceOf = (botId) => machine(botId).workspace;
export const cdpUrl = (botId) => `http://127.0.0.1:${machine(botId).port}`;

async function cdpUp(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

export async function isRunning(botId) { return !!(await cdpUp(machine(botId).port)); }

export async function ensureBrowser(botId) {
  const m = machine(botId);
  m.lastUsed = Date.now();
  if (await cdpUp(m.port)) return true;
  const bin = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
  if (!bin) throw new Error('No Chrome-family browser found. Set TANDEM_CHROME to its binary.');
  fs.mkdirSync(m.profile, { recursive: true });
  const child = spawn(bin, [
    `--remote-debugging-port=${m.port}`,
    `--user-data-dir=${m.profile}`,
    '--no-first-run', '--no-default-browser-check',
    '--window-size=1280,860',
    'about:blank',
  ], { detached: true, stdio: 'ignore' });
  child.unref();
  m.pid = child.pid;
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (await cdpUp(m.port)) {
      setWindowState(botId, 'minimized').catch(() => {});
      emit('computer', status(botId));
      return true;
    }
  }
  throw new Error('The computer browser did not start.');
}

export async function closeBrowser(botId) {
  const m = machine(botId);
  if (!(await cdpUp(m.port))) return;
  await cdpBrowser(botId, 'Browser.close').catch(() => {});
  m.pid = null;
  emit('computer', status(botId));
}

export async function restartBrowser(botId) {
  await closeBrowser(botId);
  await new Promise((r) => setTimeout(r, 800));
  return ensureBrowser(botId);
}

// Minimal CDP client over the WebSocket built into Node.
function cdpSession(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let n = 0;
    const pending = new Map();
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
      }
    };
    ws.onerror = () => reject(new Error('CDP connection failed'));
    ws.onopen = () => resolve({
      send: (method, params = {}) => new Promise((res, rej) => {
        const id = ++n;
        pending.set(id, { res, rej });
        ws.send(JSON.stringify({ id, method, params }));
        setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error(`CDP timeout: ${method}`)); } }, 15000);
      }),
      close: () => ws.close(),
    });
  });
}

async function cdpBrowser(botId, method, params) {
  const v = await cdpUp(machine(botId).port);
  if (!v) throw new Error('This Bot’s computer isn’t running');
  const s = await cdpSession(v.webSocketDebuggerUrl);
  try { return await s.send(method, params); } finally { s.close(); }
}

export async function pages(botId) {
  try {
    const r = await fetch(`${cdpUrl(botId)}/json/list`, { signal: AbortSignal.timeout(2000) });
    return (await r.json()).filter((t) => t.type === 'page');
  } catch { return []; }
}

async function withActivePage(botId, fn) {
  let list = await pages(botId);
  if (!list.length && await cdpUp(machine(botId).port)) {
    await cdpBrowser(botId, 'Target.createTarget', { url: 'about:blank' }).catch(() => {});
    list = await pages(botId);
  }
  const page = list.find((p) => !p.url.startsWith('devtools://')) || list[0];
  if (!page) return null;
  const s = await cdpSession(page.webSocketDebuggerUrl);
  try { return await fn(s, page); } finally { s.close(); }
}

async function setWindowState(botId, state) {
  const list = await pages(botId);
  if (!list[0]) return;
  const { windowId } = await cdpBrowser(botId, 'Browser.getWindowForTarget', { targetId: list[0].id });
  if (state === 'normal') await cdpBrowser(botId, 'Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
  else await cdpBrowser(botId, 'Browser.setWindowBounds', { windowId, bounds: { windowState: state } });
}

export async function screenshot(botId, quality = 55) {
  if (!(await cdpUp(machine(botId).port))) return null;
  return withActivePage(botId, async (s, page) => {
    const { data } = await s.send('Page.captureScreenshot', { format: 'jpeg', quality });
    const { cssVisualViewport: vp } = await s.send('Page.getLayoutMetrics');
    return { data, url: page.url, title: page.title, width: vp.clientWidth, height: vp.clientHeight };
  });
}

// Remote control from the app (works from a phone too).
export async function input(botId, ev) {
  return withActivePage(botId, async (s) => {
    if (ev.type === 'click') {
      for (const type of ['mousePressed', 'mouseReleased']) {
        await s.send('Input.dispatchMouseEvent', { type, x: ev.x, y: ev.y, button: 'left', clickCount: 1 });
      }
    } else if (ev.type === 'scroll') {
      await s.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: ev.x, y: ev.y, deltaX: 0, deltaY: ev.dy });
    } else if (ev.type === 'text') {
      await s.send('Input.insertText', { text: ev.text });
    } else if (ev.type === 'key') {
      const keys = { Enter: 13, Backspace: 8, Tab: 9, Escape: 27, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40 };
      const code = keys[ev.key];
      if (!code) return;
      const base = { key: ev.key, code: ev.key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code };
      await s.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base, ...(ev.key === 'Enter' ? { text: '\r' } : {}) });
      if (ev.key === 'Enter') await s.send('Input.dispatchKeyEvent', { type: 'char', ...base, text: '\r' });
      await s.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
    } else if (ev.type === 'navigate') {
      await s.send('Page.navigate', { url: ev.url });
    } else if (ev.type === 'back') {
      await s.send('Runtime.evaluate', { expression: 'history.back()' });
    }
    return true;
  });
}

export async function openUrl(botId, url) {
  await ensureBrowser(botId);
  const list = await pages(botId);
  const blank = list.find((p) => p.url === 'about:blank');
  if (blank) {
    const s = await cdpSession(blank.webSocketDebuggerUrl);
    try { await s.send('Page.navigate', { url }); } finally { s.close(); }
  } else {
    await cdpBrowser(botId, 'Target.createTarget', { url });
  }
}

// Show this Bot's browser window on the Mac (it normally stays minimized).
export async function bringToFront(botId) {
  const m = machine(botId);
  await setWindowState(botId, 'normal').catch(() => {});
  const script = m.pid
    ? `tell application "System Events" to set frontmost of (first process whose unix id is ${m.pid}) to true`
    : null;
  if (script) execFile('osascript', ['-e', script], () => {});
  const list = await pages(botId);
  if (list[0]) await cdpBrowser(botId, 'Target.activateTarget', { targetId: list[0].id }).catch(() => {});
}

export async function cookies(botId) {
  try { return (await cdpBrowser(botId, 'Storage.getCookies')).cookies || []; } catch { return []; }
}

export async function clearCookies(botId, domains) {
  const jar = await cookies(botId);
  const doomed = jar.filter((c) => domains.some((d) => c.domain.replace(/^\./, '').endsWith(d)));
  if (!doomed.length) return 0;
  await withActivePage(botId, async (s) => {
    for (const c of doomed) await s.send('Network.deleteCookies', { name: c.name, domain: c.domain, path: c.path });
  });
  return doomed.length;
}

// Fill a login form on the current page without the Bot ever seeing the values.
export async function fillLogin(botId, username, password) {
  const expr = `(() => {
    const vis = (el) => el && el.offsetParent !== null && !el.disabled;
    const setVal = (el, v) => {
      const proto = Object.getPrototypeOf(el);
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    const pass = [...document.querySelectorAll('input[type=password]')].find(vis);
    const user = [...document.querySelectorAll('input[type=email],input[autocomplete=username],input[name*=user i],input[name*=email i],input[id*=user i],input[id*=email i],input[type=text]')].find(vis);
    let filled = [];
    if (user && ${JSON.stringify(username || '')}) { setVal(user, ${JSON.stringify(username || '')}); filled.push('username'); }
    if (pass && ${JSON.stringify(password || '')}) { setVal(pass, ${JSON.stringify(password || '')}); filled.push('password'); }
    return filled.join(',');
  })()`;
  const res = await withActivePage(botId, (s) => s.send('Runtime.evaluate', { expression: expr, returnByValue: true }));
  return res?.result?.value || '';
}

export function status(botId) {
  const m = machine(botId);
  return {
    botId,
    control: m.control,
    takeover: m.takeover,
    teach: m.teach && { id: m.teach.id, goal: m.teach.goal, started: m.teach.started, frames: m.teach.frames.length, chatId: m.teach.chatId },
    activity: m.activity,
    workspace: m.workspace,
    running: !!m.pid,
  };
}
export function statusAll() {
  return Object.fromEntries([...machines.keys()].map((id) => [id, status(id)]));
}

// ---- Take over / I'm done ----------------------------------------------------
export function startTakeover({ botId, reason = 'You took control', chatId = null }) {
  const m = machine(botId);
  m.control = 'user';
  m.takeover = { reason, botId, chatId, since: Date.now() };
  emit('computer', status(botId));
}

export function endTakeover(botId) {
  const m = machine(botId);
  m.control = 'bot';
  m.takeover = null;
  for (const w of m.waiters) w();
  m.waiters.clear();
  setWindowState(botId, 'minimized').catch(() => {});
  emit('computer', status(botId));
}

export function waitForBotControl(botId) {
  const m = machine(botId);
  if (m.control === 'bot') return Promise.resolve();
  return new Promise((r) => m.waiters.add(r));
}

export function setActivity(botId, text) {
  const m = machine(botId);
  m.activity = text;
  m.lastUsed = Date.now();
  emit('computer', status(botId));
}

export function touch(botId) { machine(botId).lastUsed = Date.now(); }

// ---- Teach a task --------------------------------------------------------------
const TEACH_MAX_MS = 10 * 60 * 1000;

export async function startTeach({ chatId, botId, goal }) {
  const m = machine(botId);
  if (m.teach) throw new Error('Already recording');
  await ensureBrowser(botId);
  const id = uid('teach_');
  const dir = path.join(PATHS.teach, id);
  fs.mkdirSync(dir, { recursive: true });
  m.teach = { id, dir, chatId, botId, goal, started: Date.now(), frames: [] };
  startTakeover({ botId, reason: `Teaching: ${goal}`, chatId });
  bringToFront(botId).catch(() => {});
  m.teachTimer = setInterval(async () => {
    const t = m.teach;
    if (!t) return;
    if (Date.now() - t.started > TEACH_MAX_MS) { emit('teach.limit', { id, botId }); return stopTeach(botId); }
    try {
      const shot = await screenshot(botId, 45);
      if (!shot) return;
      const file = path.join(dir, `frame-${String(t.frames.length).padStart(4, '0')}.jpg`);
      fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
      t.frames.push({ file, url: shot.url, title: shot.title, at: Date.now() - t.started });
      emit('computer', status(botId));
    } catch {}
  }, 2000);
  return m.teach;
}

export function stopTeach(botId) {
  const m = machine(botId);
  clearInterval(m.teachTimer);
  const t = m.teach;
  m.teach = null;
  endTakeover(botId);
  if (t) fs.writeFileSync(path.join(t.dir, 'frames.json'), JSON.stringify(t.frames, null, 2));
  return t;
}

export function teaching() {
  for (const m of machines.values()) if (m.teach) return m;
  return null;
}

// ---- Housekeeping ----------------------------------------------------------------
// Close browsers nobody has used for a while (sign-ins stay in the profile).
export function startIdleReaper(isBusy) {
  setInterval(async () => {
    for (const m of machines.values()) {
      if (!m.pid || m.control === 'user' || m.teach || isBusy(m.botId)) continue;
      if (Date.now() - m.lastUsed > IDLE_MS) await closeBrowser(m.botId).catch(() => {});
    }
  }, 60 * 1000);
}

// v0.1 had one computer shared by every Bot. Its browser profile (with your sign-ins)
// becomes the primary Bot's computer; its workspace becomes the Shared folder.
export async function migrateLegacy(primaryBotId) {
  const legacy = path.join(PATHS.data, 'computer');
  if (!fs.existsSync(legacy)) return null;
  // Close the old browser only if it runs from THIS data folder's profile (never another Tandem's).
  const profile = path.join(legacy, 'chrome-profile');
  const pids = await new Promise((resolve) => execFile('ps', ['-axo', 'pid=,command='], { maxBuffer: 8 << 20 }, (err, out) => {
    if (err) return resolve([]);
    resolve(out.split('\n').filter((l) => l.includes(`--user-data-dir=${profile}`) && !l.includes('--type=')).map((l) => Number(l.trim().split(/\s+/)[0])).filter(Boolean));
  }));
  for (const pid of pids) { try { process.kill(pid, 'SIGTERM'); } catch {} }
  if (pids.length) await new Promise((r) => setTimeout(r, 2000));
  const oldWs = path.join(legacy, 'workspace');
  if (fs.existsSync(oldWs)) {
    for (const f of fs.readdirSync(oldWs)) {
      const dest = path.join(PATHS.shared, f);
      if (!fs.existsSync(dest)) fs.renameSync(path.join(oldWs, f), dest);
    }
  }
  const oldProfile = path.join(legacy, 'chrome-profile');
  if (primaryBotId && fs.existsSync(oldProfile)) {
    const m = machine(primaryBotId);
    if (!fs.existsSync(m.profile)) { fs.mkdirSync(m.dir, { recursive: true }); fs.renameSync(oldProfile, m.profile); }
  }
  fs.renameSync(legacy, path.join(PATHS.data, `computer-v0.1-${Date.now()}`));
  return { primaryBotId };
}
