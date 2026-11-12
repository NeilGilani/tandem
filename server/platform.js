// The few things that differ between macOS, Windows and Linux, in one place.
import { execFile, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const MAC = process.platform === 'darwin';
export const WIN = process.platform === 'win32';
// What to call this machine in text shown to people and Bots.
export const MACHINE = MAC ? 'Mac' : WIN ? 'PC' : 'computer';

const env = (k) => process.env[k] || '';
const winDirs = () => [env('ProgramFiles'), env('ProgramFiles(x86)'), env('LOCALAPPDATA')].filter(Boolean);

// Chrome-family browsers, best first.
export function chromeCandidates() {
  const list = [process.env.TANDEM_CHROME];
  if (MAC) list.push(
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser');
  else if (WIN) for (const rel of ['Google\\Chrome\\Application\\chrome.exe', 'Chromium\\Application\\chrome.exe',
    'Microsoft\\Edge\\Application\\msedge.exe', 'BraveSoftware\\Brave-Browser\\Application\\brave.exe']) {
    for (const d of winDirs()) list.push(path.join(d, rel));
  }
  list.push('/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge', '/usr/bin/brave-browser');
  return list.filter(Boolean);
}
export const findChrome = () => chromeCandidates().find((p) => fs.existsSync(p)) || null;

const powershell = (script, opts = {}) => new Promise((resolve) => {
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true, timeout: 20000, ...opts },
    (err, out) => resolve(err ? null : String(out).trim()));
});

// Bring a program's window to the front (used when you take over a Bot's browser).
export function focusProcess(pid) {
  if (!Number.isInteger(pid)) return;
  if (MAC) execFile('osascript', ['-e', `tell application "System Events" to set frontmost of (first process whose unix id is ${pid}) to true`], () => {});
  else if (WIN) powershell(`$null = (New-Object -ComObject WScript.Shell).AppActivate(${pid})`);
}

// A desktop notification from the server side (the app's own notifications come from the page).
export function notify(title, message) {
  if (!WIN) return Promise.resolve(false);
  const q = (s) => `'${String(s).replace(/'/g, "''").replace(/[\r\n]+/g, ' ').slice(0, 250)}'`;
  return powershell('Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; $n = New-Object System.Windows.Forms.NotifyIcon; ' +
    `$n.Icon = [System.Drawing.SystemIcons]::Information; $n.Visible = $true; $n.ShowBalloonTip(8000, ${q(title)}, ${q(message)}, 'Info'); Start-Sleep -Seconds 9; $n.Dispose()`,
  { timeout: 30000 }).then((r) => r !== null);
}

// Keep the computer from idle-sleeping while Bots work. Returns a child process to kill
// when it may sleep again, or null where that isn't supported.
export function keepAwake() {
  if (MAC) return spawn('caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' });
  if (WIN) {
    // ES_CONTINUOUS | ES_SYSTEM_REQUIRED, held for as long as this helper lives; it leaves when Tandem does.
    const script = `$sig = '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);'; ` +
      `$k = Add-Type -MemberDefinition $sig -Name Awake -Namespace Tandem -PassThru; $null = $k::SetThreadExecutionState(0x80000001); ` +
      `try { Wait-Process -Id ${process.pid} -ErrorAction SilentlyContinue } catch {}`;
    return spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { stdio: 'ignore', windowsHide: true });
  }
  return null;
}

// Copy a folder, skipping entries by name ('Singleton*' style prefixes allowed). The
// destination ends up holding only what the source has now.
export async function mirrorDir(src, dst, exclude = []) {
  const skip = (name) => exclude.some((e) => (e.endsWith('*') ? name.startsWith(e.slice(0, -1)) : name === e));
  if (!WIN) {
    const done = await new Promise((resolve) => {
      const c = spawn('rsync', ['-a', '--delete', ...exclude.flatMap((e) => ['--exclude', e]), `${src}/`, `${dst}/`], { stdio: 'ignore' });
      c.on('close', (code) => resolve(code === 0)); c.on('error', () => resolve(false));
    });
    if (done) return;
  }
  await fs.promises.rm(dst, { recursive: true, force: true, maxRetries: 3 });
  await fs.promises.cp(src, dst, { recursive: true, force: true, filter: (from) => !skip(path.basename(from)) }).catch(() => {});
}

// A Python 3 that can make virtual environments.
export function systemPython() {
  const tries = WIN
    ? [['py', ['-3']], ['python', []], ['python3', []]]
    : [['/opt/homebrew/bin/python3', []], ['/usr/local/bin/python3', []], ['/usr/bin/python3', []]];
  for (const [cmd, pre] of tries) {
    if (!WIN && !fs.existsSync(cmd)) continue;
    try {
      // The Microsoft Store stub named python.exe exits non-zero here, so it is skipped.
      const out = execFileSyncQuiet(cmd, [...pre, '-c', 'import venv, ensurepip, sys; print(sys.executable)']);
      if (out) return WIN ? out : cmd;
    } catch {}
  }
  return null;
}
function execFileSyncQuiet(cmd, args) {
  const r = spawnSyncSafe(cmd, args);
  return r.status === 0 ? String(r.stdout).trim().split(/\r?\n/).pop() : '';
}
const spawnSyncSafe = (cmd, args) => spawnSync(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'], timeout: 20000, windowsHide: true });

// Where a virtual environment keeps its python.
export const venvPython = (dir) => (WIN ? path.join(dir, 'Scripts', 'python.exe') : path.join(dir, 'bin', 'python'));

// The Claude Code program. On Windows an app started at login may not have it on PATH yet.
export function findClaude() {
  if (process.env.TANDEM_CLAUDE) return process.env.TANDEM_CLAUDE;
  if (WIN) {
    for (const p of [path.join(os.homedir(), '.local', 'bin', 'claude.exe'), path.join(env('LOCALAPPDATA'), 'Programs', 'claude', 'claude.exe')]) {
      if (fs.existsSync(p)) return p;
    }
  }
  return 'claude';
}
