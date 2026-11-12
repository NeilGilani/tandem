// The toolbox: a Python every Bot can use right away, with the usual packages for data,
// charts, documents and scraping already installed. Built once in the background so a
// Bot never stalls mid-task waiting on pip.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from './db.js';
import { systemPython, venvPython } from './platform.js';

const PACKAGES = ['pandas', 'numpy', 'matplotlib', 'openpyxl', 'xlsxwriter', 'requests', 'beautifulsoup4', 'lxml',
  'python-docx', 'python-pptx', 'pypdf', 'reportlab', 'pillow', 'python-dateutil', 'tabulate'];
const VERSION = `1:${PACKAGES.join(',')}`;

const DIR = path.join(PATHS.data, 'toolbox', 'py');
const PY = venvPython(DIR);
const MARK = path.join(DIR, '.tandem-ready');
let building = null;
let state = 'idle'; // idle | building | ready | unavailable

export const python = () => (ready() ? PY : null);
export const status = () => ({ state: ready() ? 'ready' : state, python: ready() ? PY : null, packages: PACKAGES });

function ready() {
  try { return fs.readFileSync(MARK, 'utf8') === VERSION && fs.existsSync(PY); } catch { return false; }
}


const sh = (cmd, args) => new Promise((resolve, reject) => {
  const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  let err = '';
  child.stderr.on('data', (d) => (err = (err + d).slice(-2000)));
  child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.trim().split('\n').pop() || `exit ${code}`))));
});

// Build (or rebuild after the package list changes). Retries on a later start if it fails.
export function ensure() {
  if (ready() || building) return building;
  const base = systemPython();
  if (!base) { state = 'unavailable'; return null; }
  state = 'building';
  building = (async () => {
    try {
      fs.rmSync(DIR, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(DIR), { recursive: true });
      await sh(base, ['-m', 'venv', DIR]);
      await sh(PY, ['-m', 'pip', 'install', '-q', '--disable-pip-version-check', '--upgrade', 'pip']);
      await sh(PY, ['-m', 'pip', 'install', '-q', '--disable-pip-version-check', '--retries', '10', '--timeout', '60', ...PACKAGES]);
      fs.writeFileSync(MARK, VERSION);
      state = 'ready';
      console.log('toolbox ready:', PY);
    } catch (e) {
      state = 'idle';
      console.error('toolbox build failed:', e.message);
    } finally {
      building = null;
    }
  })();
  return building;
}

export function promptBlock() {
  if (!ready()) return '';
  return `- Python toolbox: ${PY} already has ${PACKAGES.join(', ')}. Use it for scripts instead of
  installing packages (run \`${PY} script.py\`). Only make your own venv for a package that isn't there.`;
}
