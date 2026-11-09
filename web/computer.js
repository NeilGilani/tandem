// Computer panel: live view of the shared computer, Take over / Take control, I'm done, Teach.
import { api, h, icon, toast, time } from './lib.js';
import { S, bot, toggleComputer } from './store.js';

const $el = document.getElementById('computer');
let timer = null;
let img = null, meta = { url: '', title: '', vw: 1280, vh: 800 };
let offline = false;

async function poll() {
  if (!S.showComputer) return;
  try {
    const r = await fetch('/api/computer/screenshot', { cache: 'no-store' });
    if (!r.ok) throw new Error('offline');
    const blob = await r.blob();
    meta.url = decodeURIComponent(r.headers.get('X-Page-Url') || '');
    meta.title = decodeURIComponent(r.headers.get('X-Page-Title') || '');
    const [vw, vh] = (r.headers.get('X-Viewport') || '1280x800').split('x').map(Number);
    meta.vw = vw; meta.vh = vh;
    const url = URL.createObjectURL(blob);
    if (img) { const old = img.src; img.src = url; if (old.startsWith('blob:')) URL.revokeObjectURL(old); }
    if (offline) { offline = false; renderComputer(); }
    const u = $el.querySelector('.cp-url');
    if (u) u.textContent = meta.url || ' ';
  } catch {
    if (!offline) { offline = true; renderComputer(); }
  }
}

function schedule() {
  clearTimeout(timer);
  if (!S.showComputer) return;
  const fast = S.computer.control === 'user' || S.runs.length;
  timer = setTimeout(async () => { await poll(); schedule(); }, fast ? 700 : 2000);
}

function toPage(e) {
  const r = img.getBoundingClientRect();
  // object-fit: contain → find the drawn image box.
  const scale = Math.min(r.width / meta.vw, r.height / meta.vh);
  const dw = meta.vw * scale, dh = meta.vh * scale;
  const ox = (r.width - dw) / 2, oy = (r.height - dh) / 2;
  const x = (e.clientX - r.left - ox) / scale, y = (e.clientY - r.top - oy) / scale;
  if (x < 0 || y < 0 || x > meta.vw || y > meta.vh) return null;
  return { x: Math.round(x), y: Math.round(y) };
}

export function renderComputer() {
  if (!S.showComputer) { clearTimeout(timer); return; }
  const c = S.computer || {};
  const control = c.control === 'user';
  const teach = c.teach;
  const takeoverBot = c.takeover?.botId && bot(c.takeover.botId);

  img = h('img', { alt: '', draggable: false, hidden: offline });
  const screen = h(`div.cp-screen${control ? '.control' : ''}`, img, offline && h('div.cp-off', h('div', 'The computer browser isn’t running.', h('br'), h('button.btn', { style: { marginTop: '8px' }, on: { click: () => api('POST', '/api/computer/start').then(poll) } }, 'Start it'))));
  if (control) {
    img.addEventListener('click', (e) => { const p = toPage(e); if (p) api('POST', '/api/computer/input', { type: 'click', ...p }).then(poll); });
    img.addEventListener('wheel', (e) => { e.preventDefault(); const p = toPage(e); if (p) api('POST', '/api/computer/input', { type: 'scroll', ...p, dy: e.deltaY }); }, { passive: false });
  }
  const typeBox = h('input.input', { placeholder: 'Type into the page…', autocomplete: 'off', on: { keydown: (e) => {
    if (e.key === 'Enter') { e.preventDefault(); if (e.target.value) api('POST', '/api/computer/input', { type: 'text', text: e.target.value }).then(() => api('POST', '/api/computer/input', { type: 'key', key: 'Enter' })).then(poll); e.target.value = ''; }
    else if (['Tab', 'Backspace', 'Escape', 'ArrowUp', 'ArrowDown'].includes(e.key) && !e.target.value) { e.preventDefault(); api('POST', '/api/computer/input', { type: 'key', key: e.key }).then(poll); }
  } } });
  const urlBox = h('input.input', { placeholder: 'Go to URL', on: { keydown: (e) => {
    if (e.key === 'Enter' && e.target.value) { let u = e.target.value.trim(); if (!/^https?:/.test(u)) u = 'https://' + u; api('POST', '/api/computer/input', { type: 'navigate', url: u }).then(poll); e.target.value = ''; }
  } } });

  $el.replaceChildren(...[
    h('div.cp-head', icon('monitor'), h('b', 'Computer'),
      h('button.icon-btn', { title: 'Show the browser window on this Mac', on: { click: () => api('POST', '/api/computer/focus') } }, icon('open')),
      h('button.icon-btn', { title: 'Close', on: { click: () => toggleComputer(false) } }, icon('x'))),
    screen,
    h('div.cp-url', meta.url || ' '),
    h('div.cp-activity', control ? 'You have control. Bots wait until you press I’m done.' : (c.activity || (S.runs.length ? 'Working…' : 'Idle'))),
    control && !teach && h('div.cp-banner',
      h('div', h('b', takeoverBot ? `${takeoverBot.name} needs you: ` : ''), c.takeover?.reason || 'You took control.'),
      h('div.hint', 'Complete only that step. Click and scroll on the screen above, type below — or use the browser window on this Mac.'),
      h('div.row', h('button.btn.primary', { on: { click: () => api('POST', '/api/computer/done') } }, "I'm done"))),
    control && h('div.cp-type', h('button.icon-btn', { title: 'Back', on: { click: () => api('POST', '/api/computer/input', { type: 'back' }).then(poll) } }, icon('back')), urlBox),
    control && h('div.cp-type', typeBox),
    teach && h('div.cp-teach',
      h('div', h('span.rec'), ' ', h('b', 'Recording'), ` · ${teach.frames} frames · started ${time(teach.started)}`),
      h('div', teach.goal),
      h('div.hint', 'Do the task once. Recording stops automatically after ten minutes. No audio is captured.'),
      h('div.row', h('button.btn.primary', { on: { click: () => api('POST', '/api/computer/teach/stop').then(() => toast('Drafting a skill from your demonstration…')) } }, 'Stop recording'))),
    !control && h('div.cp-actions',
      h('button.btn', { on: { click: () => api('POST', '/api/computer/takeover', { reason: 'You took control' }) } }, icon('hand'), 'Take control'),
      h('button.btn', { on: { click: () => api('POST', '/api/computer/takeover', { reason: 'You took over in the browser window', focus: true }) } }, icon('open'), 'Take over'),
      h('button.btn.ghost', { title: 'Restart the computer browser', on: { click: () => api('POST', '/api/computer/restart').then(() => toast('Restarted')).then(poll) } }, icon('refresh'))),
    h('div.cp-files', 'Files: ', h('code', S.settings.workspace || '')),
  ].filter(Boolean));
  poll();
  schedule();
}
