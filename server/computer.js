// The shared computer: one Chrome (own profile) + one workspace folder, shared by
// every Bot. Bots drive the browser through Playwright MCP over CDP; this module
// launches it, streams screenshots for the Computer panel, forwards your input when
// you take control, checks sign-in cookies for Connect apps, and records Teach mode.
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { PATHS, uid } from './db.js';
import { emit } from './bus.js';

export const CDP_PORT = Number(process.env.TANDEM_CDP_PORT || 9333);
export const CDP_URL = `http://127.0.0.1:${CDP_PORT}`;

const CHROME_CANDIDATES = [
  process.env.TANDEM_CHROME,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);

export const state = {
  pid: null,
  control: 'bot', // 'bot' | 'user' — while 'user', Bots' browser actions wait
  takeover: null, // { reason, botId, chatId, since }
  teach: null, // { id, chatId, botId, goal, started, frames: [] }
  activity: '', // last thing a Bot did in the browser
};

async function cdpUp() {
  try {
    const r = await fetch(`${CDP_URL}/json/version`, { signal: AbortSignal.timeout(1500) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

export async function ensureBrowser() {
  if (await cdpUp()) return true;
  const bin = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
  if (!bin) throw new Error('No Chrome-family browser found. Set TANDEM_CHROME to its binary.');
  const child = spawn(bin, [
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${PATHS.chrome}`,
    '--no-first-run', '--no-default-browser-check',
    '--window-size=1280,860',
    'about:blank',
  ], { detached: true, stdio: 'ignore' });
  child.unref();
  state.pid = child.pid;
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (await cdpUp()) { emit('computer', status()); return true; }
  }
  throw new Error('The computer browser did not start.');
}

export async function restartBrowser() {
  const v = await cdpUp();
  if (v) await cdpBrowser('Browser.close').catch(() => {});
  await new Promise((r) => setTimeout(r, 800));
  return ensureBrowser();
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

async function cdpBrowser(method, params) {
  const v = await cdpUp();
  if (!v) throw new Error('Computer browser is not running');
  const s = await cdpSession(v.webSocketDebuggerUrl);
  try { return await s.send(method, params); } finally { s.close(); }
}

export async function pages() {
  try {
    const r = await fetch(`${CDP_URL}/json/list`, { signal: AbortSignal.timeout(2000) });
    return (await r.json()).filter((t) => t.type === 'page');
  } catch { return []; }
}

async function withActivePage(fn) {
  let list = await pages();
  if (!list.length && await cdpUp()) {
    // A Bot closed the last tab: keep one page open so the computer always has a screen.
    await cdpBrowser('Target.createTarget', { url: 'about:blank' }).catch(() => {});
    list = await pages();
  }
  const page = list.find((p) => !p.url.startsWith('devtools://')) || list[0];
  if (!page) return null;
  const s = await cdpSession(page.webSocketDebuggerUrl);
  try { return await fn(s, page); } finally { s.close(); }
}

export async function screenshot(quality = 55) {
  return withActivePage(async (s, page) => {
    const { data } = await s.send('Page.captureScreenshot', { format: 'jpeg', quality });
    const { cssVisualViewport: vp } = await s.send('Page.getLayoutMetrics');
    return { data, url: page.url, title: page.title, width: vp.clientWidth, height: vp.clientHeight };
  });
}

// Remote control from the Computer panel (works from a phone too).
export async function input(ev) {
  return withActivePage(async (s) => {
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

export async function openUrl(url) {
  await ensureBrowser();
  const list = await pages();
  const blank = list.find((p) => p.url === 'about:blank');
  if (blank) {
    const s = await cdpSession(blank.webSocketDebuggerUrl);
    try { await s.send('Page.navigate', { url }); } finally { s.close(); }
  } else {
    await cdpBrowser('Target.createTarget', { url });
  }
}

export function bringToFront() {
  const pid = state.pid;
  const script = pid
    ? `tell application "System Events" to set frontmost of (first process whose unix id is ${pid}) to true`
    : 'tell application "System Events" to set frontmost of (first process whose name contains "Chrome") to true';
  execFile('osascript', ['-e', script], () => {});
}

export async function cookies() {
  try { return (await cdpBrowser('Storage.getCookies')).cookies || []; } catch { return []; }
}

export async function clearCookies(domains) {
  const all = await cookies();
  const doomed = all.filter((c) => domains.some((d) => c.domain.replace(/^\./, '').endsWith(d)));
  if (!doomed.length) return 0;
  await withActivePage(async (s) => {
    for (const c of doomed) await s.send('Network.deleteCookies', { name: c.name, domain: c.domain, path: c.path });
  });
  return doomed.length;
}

// Fill a login form on the current page without the Bot ever seeing the values.
export async function fillLogin(username, password) {
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
  const res = await withActivePage((s) => s.send('Runtime.evaluate', { expression: expr, returnByValue: true }));
  return res?.result?.value || '';
}

export function status() {
  return {
    control: state.control,
    takeover: state.takeover,
    teach: state.teach && { id: state.teach.id, goal: state.teach.goal, started: state.teach.started, frames: state.teach.frames.length },
    activity: state.activity,
    workspace: PATHS.workspace,
  };
}

// ---- Take over / I'm done ----------------------------------------------------
const takeoverWaiters = new Set();

export function startTakeover({ reason = 'You took control', botId = null, chatId = null } = {}) {
  state.control = 'user';
  state.takeover = { reason, botId, chatId, since: Date.now() };
  emit('computer', status());
}

export function endTakeover() {
  state.control = 'bot';
  state.takeover = null;
  for (const w of takeoverWaiters) w();
  takeoverWaiters.clear();
  emit('computer', status());
}

export function waitForBotControl() {
  if (state.control === 'bot') return Promise.resolve();
  return new Promise((r) => takeoverWaiters.add(r));
}

export function setActivity(text) {
  state.activity = text;
  emit('computer', status());
}

// ---- Teach a task --------------------------------------------------------------
const TEACH_MAX_MS = 10 * 60 * 1000;
let teachTimer = null;

export function startTeach({ chatId, botId, goal }) {
  if (state.teach) throw new Error('Already recording');
  const id = uid('teach_');
  const dir = path.join(PATHS.teach, id);
  fs.mkdirSync(dir, { recursive: true });
  state.teach = { id, dir, chatId, botId, goal, started: Date.now(), frames: [], lastUrl: '' };
  startTakeover({ reason: `Teaching: ${goal}`, botId, chatId });
  teachTimer = setInterval(async () => {
    const t = state.teach;
    if (!t) return;
    if (Date.now() - t.started > TEACH_MAX_MS) { emit('teach.limit', { id }); return stopTeach(); }
    try {
      const shot = await screenshot(45);
      if (!shot) return;
      const file = path.join(dir, `frame-${String(t.frames.length).padStart(4, '0')}.jpg`);
      fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
      t.frames.push({ file, url: shot.url, title: shot.title, at: Date.now() - t.started });
      emit('computer', status());
    } catch {}
  }, 2000);
  return state.teach;
}

export function stopTeach() {
  clearInterval(teachTimer);
  const t = state.teach;
  state.teach = null;
  endTakeover();
  if (t) fs.writeFileSync(path.join(t.dir, 'frames.json'), JSON.stringify(t.frames, null, 2));
  return t;
}
