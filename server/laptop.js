// Laptops: every Bot gets its own Linux laptop, a container in a small VM (Colima
// profile "tandem", capped at 5 GB for the whole team). A laptop has a desktop, a
// browser the Bot drives over CDP, a terminal its shell commands run in, its own files
// and a live screen you can watch or take over. Laptops sleep when idle and wake in
// seconds; their disks persist.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT, PATHS, setting, timezone } from './db.js';
import { emit } from './bus.js';

export const PROFILE = 'tandem';
export const IMAGE = 'tandem-laptop:1';
const SOCK = process.env.TANDEM_DOCKER_HOST || `unix://${os.homedir()}/.colima/${PROFILE}/docker.sock`;
const BIN = (name) => ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'].map((d) => path.join(d, name)).find((p) => fs.existsSync(p)) || name;
export const SCREEN = { w: 1280, h: 800 };
export const nameOf = (botId) => `tandem-${botId.replace(/[^a-zA-Z0-9_.-]/g, '')}`;

let state = { status: 'unknown', detail: '' }; // unknown | ready | starting | building | missing | error
export const status = () => state;
const setState = (status, detail = '') => { state = { status, detail }; emit('settings'); };

function sh(cmd, args, { timeout = 120000, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { timeout, maxBuffer: 64 * 1024 * 1024, encoding: 'buffer', env: { ...process.env, DOCKER_HOST: SOCK, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH}` } },
      (err, stdout, stderr) => (err ? reject(Object.assign(new Error(String(stderr || err.message).trim().split('\n').pop()), { code: err.code, stdout })) : resolve(stdout)));
    if (input != null) child.stdin.end(input);
  });
}
export const docker = (args, opts) => sh(BIN('docker'), args, opts);
const text = async (args, opts) => String(await docker(args, opts)).trim();

// The VM and the image. Called at startup and before a laptop starts.
let preparing = null;
export function prepare() {
  if (state.status === 'ready') return Promise.resolve(true);
  if (preparing) return preparing;
  preparing = (async () => {
    try {
      if (!fs.existsSync(BIN('colima')) || !fs.existsSync(BIN('docker'))) { setState('missing', 'Install Colima and Docker: brew install colima docker'); return false; }
      try { await text(['info', '--format', '{{.ServerVersion}}'], { timeout: 8000 }); }
      catch {
        setState('starting', 'Starting the laptops VM');
        await sh(BIN('colima'), ['start', PROFILE, '--vm-type', 'vz', '--mount-type', 'virtiofs', '--cpu', '4', '--memory', '5', '--disk', '40', '--mount', `${PATHS.data}:w`, '--runtime', 'docker'], { timeout: 600000 });
      }
      const has = await text(['images', '-q', IMAGE]).catch(() => '');
      if (!has) {
        setState('building', 'Building the laptop image (one time, a few minutes)');
        await docker(['build', '-t', IMAGE, path.join(ROOT, 'laptop')], { timeout: 3600000 });
      }
      setState('ready');
      return true;
    } catch (e) {
      setState('error', e.message);
      return false;
    } finally { preparing = null; }
  })();
  return preparing;
}

// Laptops are on unless you chose the Mac browser, or Colima and Docker aren't installed.
const installed = () => ['colima', 'docker'].every((n) => ['/opt/homebrew/bin', '/usr/local/bin'].some((d) => fs.existsSync(path.join(d, n))));
export const enabled = () => { const m = setting('computer_mode'); return m === 'laptop' || (m !== 'mac' && installed()); };

// Mac folders every laptop can open, at the same path as on the Mac.
function folders(workspace) {
  const extra = (() => { try { return JSON.parse(setting('laptop_folders') || '[]'); } catch { return []; } })();
  return [...new Set([workspace, PATHS.shared, PATHS.uploads, ...extra])].filter((f) => fs.existsSync(f));
}

// Start (or wake) a Bot's laptop. ports: { cdp, screen }.
export async function ensure(botId, { workspace, ports }) {
  if (!(await prepare())) throw new Error(`Laptops aren't available: ${state.detail}`);
  const name = nameOf(botId);
  const running = await text(['inspect', '-f', '{{.State.Running}}', name]).catch(() => null);
  if (running === 'true') return false;
  if (running === 'false') { await docker(['start', name]); return true; }
  fs.mkdirSync(workspace, { recursive: true });
  const uid = process.getuid?.() ?? 501, gid = process.getgid?.() ?? 20;
  await docker(['run', '-d', '--name', name, '--label', `tandem.bot=${botId}`, '--hostname', 'laptop',
    '--user', `${uid}:${gid}`, '-e', `HOME=${workspace}`, '-e', `TZ=${timezone()}`, '-w', workspace,
    '--memory', '900m', '--memory-swap', '1500m', '--shm-size', '256m', '--restart', 'no',
    ...folders(workspace).flatMap((f) => ['-v', `${f}:${f}`]),
    '-p', `127.0.0.1:${ports.cdp}:9223`, '-p', `127.0.0.1:${ports.screen}:6080`, IMAGE]);
  return true;
}

export const stop = (botId) => docker(['stop', '-t', '3', nameOf(botId)]).catch(() => {});
export const remove = (botId) => docker(['rm', '-f', nameOf(botId)]).catch(() => {});
export async function isRunning(botId) { return (await text(['inspect', '-f', '{{.State.Running}}', nameOf(botId)]).catch(() => '')) === 'true'; }

// Run a command on the laptop as its user, with the screen available to GUI apps.
export const exec = (botId, script, opts = {}) => docker(['exec', '-i', '-e', 'DISPLAY=:1', nameOf(botId), 'sh', '-c', script], opts);

// The whole desktop, not just the browser tab.
export async function screenshot(botId, quality = 60) {
  const buf = await exec(botId, `import -display :1 -window root -quality ${quality} jpg:-`, { timeout: 15000 });
  return { data: buf.toString('base64'), mime: 'image/jpeg' };
}

// Mouse and keyboard on the desktop (for Bots using desktop apps, and Teach replays).
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
export async function desktop(botId, a) {
  const x = Math.round(Number(a.x) || 0), y = Math.round(Number(a.y) || 0);
  const cmd = {
    click: `xdotool mousemove ${x} ${y} click ${a.button === 'right' ? 3 : 1}`,
    double_click: `xdotool mousemove ${x} ${y} click --repeat 2 1`,
    move: `xdotool mousemove ${x} ${y}`,
    drag: `xdotool mousemove ${x} ${y} mousedown 1 mousemove ${Math.round(a.x2)} ${Math.round(a.y2)} mouseup 1`,
    scroll: `xdotool mousemove ${x} ${y} click --repeat ${Math.min(Math.abs(Number(a.amount) || 3), 20)} ${Number(a.amount) < 0 ? 4 : 5}`,
    type: `xdotool type --delay 12 -- ${q(a.text || '')}`,
    key: `xdotool key -- ${String(a.keys || '').split(/\s+/).filter(Boolean).map(q).join(' ')}`,
    open: `(nohup ${{ browser: 'chromium', terminal: 'lxterminal', files: 'pcmanfm', spreadsheet: 'libreoffice --calc', document: 'libreoffice --writer', slides: 'libreoffice --impress', editor: 'mousepad' }[a.app] || 'true'} ${a.file ? q(a.file) : ''} >/dev/null 2>&1 &)`,
  }[a.action];
  if (!cmd) throw new Error(`Unknown desktop action: ${a.action}`);
  await exec(botId, cmd, { timeout: 30000 });
}

// Memory use per laptop, for Settings.
export async function usage() {
  const out = await text(['stats', '--no-stream', '--format', '{{.Name}}\t{{.MemUsage}}']).catch(() => '');
  return Object.fromEntries(out.split('\n').filter(Boolean).map((l) => { const [n, m] = l.split('\t'); return [n, m.split('/')[0].trim()]; }));
}

// The shell wrapper Claude Code uses so a Bot's commands run on its laptop.
export const shellPrefix = () => path.join(ROOT, 'laptop', 'run-in-laptop.sh');
