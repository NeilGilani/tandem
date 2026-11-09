// Computer panel: a live view of one Bot's own computer, with Take control,
// Take over, I'm done and Teach. Shows the Bot of the current conversation;
// the menu at the top switches to any other Bot's computer.
import { api, h, icon, toast, avatar, menu } from './lib.js';
import { S, bot, comp, focusBot, toggleComputer } from './store.js';

const $el = document.getElementById('computer');
let timer = null;
let img = null, meta = { url: '', title: '', vw: 1280, vh: 800 };
let offline = false;
let shownBot = null;

async function poll() {
  if (!S.showComputer || !shownBot) return;
  try {
    const r = await fetch(`/api/computer/screenshot?bot=${encodeURIComponent(shownBot)}`, { cache: 'no-store' });
    if (!r.ok) throw new Error('offline');
    const blob = await r.blob();
    meta.url = decodeURIComponent(r.headers.get('X-Page-Url') || '');
    meta.title = decodeURIComponent(r.headers.get('X-Page-Title') || '');
    const [vw, vh] = (r.headers.get('X-Viewport') || '1280x800').split('x').map(Number);
    meta.vw = vw; meta.vh = vh;
    const url = URL.createObjectURL(blob);
    if (img) { const old = img.src; img.src = url; img.hidden = false; if (old.startsWith('blob:')) URL.revokeObjectURL(old); }
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
  const fast = comp(shownBot).control === 'user' || S.runs.some((r) => r.botId === shownBot);
  timer = setTimeout(async () => { await poll(); schedule(); }, fast ? 700 : 2000);
}

function toPage(e) {
  const r = img.getBoundingClientRect();
  const scale = Math.min(r.width / meta.vw, r.height / meta.vh);
  const dw = meta.vw * scale, dh = meta.vh * scale;
  const ox = (r.width - dw) / 2, oy = (r.height - dh) / 2;
  const x = (e.clientX - r.left - ox) / scale, y = (e.clientY - r.top - oy) / scale;
  if (x < 0 || y < 0 || x > meta.vw || y > meta.vh) return null;
  return { x: Math.round(x), y: Math.round(y) };
}

export function renderComputer() {
  if (!S.showComputer) { clearTimeout(timer); return; }
  const id = focusBot();
  if (id !== shownBot) { shownBot = id; offline = false; meta = { url: '', title: '', vw: 1280, vh: 800 }; }
  const b = bot(shownBot);
  if (!b) {
    $el.replaceChildren(h('div.cp-head', h('b', 'Computer'), h('button.icon-btn', { on: { click: () => toggleComputer(false) } }, icon('x'))),
      h('div.cp-activity', 'Create a Bot first. Each Bot gets its own computer.'));
    return;
  }
  const c = comp(shownBot);
  const control = c.control === 'user';
  const working = S.runs.find((r) => r.botId === shownBot);
  const body = { botId: shownBot };
  const send = (ev) => api('POST', '/api/computer/input', { ...body, ...ev }).then(poll);

  img = h('img', { alt: '', draggable: false, hidden: offline });
  const screen = h(`div.cp-screen${control ? '.control' : ''}`, img, offline && h('div.cp-off', h('div', `${b.name}'s computer is asleep.`, h('br'),
    h('button.btn', { style: { marginTop: '10px', background: '#fff', color: '#111' }, on: { click: () => api('POST', '/api/computer/start', body).then(poll) } }, 'Wake it up'))));
  if (control) {
    img.addEventListener('click', (e) => { const p = toPage(e); if (p) send({ type: 'click', ...p }); });
    img.addEventListener('wheel', (e) => { e.preventDefault(); const p = toPage(e); if (p) api('POST', '/api/computer/input', { ...body, type: 'scroll', ...p, dy: e.deltaY }); }, { passive: false });
  }
  const typeBox = h('input.input', { placeholder: 'Type into the page', autocomplete: 'off', on: { keydown: (e) => {
    if (e.key === 'Enter') { e.preventDefault(); if (e.target.value) send({ type: 'text', text: e.target.value }).then(() => send({ type: 'key', key: 'Enter' })); e.target.value = ''; }
    else if (['Tab', 'Backspace', 'Escape', 'ArrowUp', 'ArrowDown'].includes(e.key) && !e.target.value) { e.preventDefault(); send({ type: 'key', key: e.key }); }
  } } });
  const urlBox = h('input.input', { placeholder: 'Go to a website', on: { keydown: (e) => {
    if (e.key === 'Enter' && e.target.value) { let u = e.target.value.trim(); if (!/^https?:/.test(u)) u = 'https://' + u; send({ type: 'navigate', url: u }); e.target.value = ''; }
  } } });
  const switcher = h('button', { style: { display: 'flex', alignItems: 'center', gap: '8px', border: 0, background: 'none', padding: '4px 6px', borderRadius: '8px', fontWeight: 600, color: 'var(--text)', minWidth: 0 },
    title: 'Show another Bot’s computer',
    on: { click: (e) => {
      const r = e.currentTarget.getBoundingClientRect();
      menu(r.left, r.bottom + 4, S.bots.map((x) => ({ label: `${x.name}${S.runs.some((q) => q.botId === x.id) ? ' (working)' : ''}`, onClick: () => { S.focusBot = x.id; shownBot = null; renderComputer(); } })));
    } } }, avatar(b, 20), `${b.name}'s computer`);

  $el.replaceChildren(...[
    h('div.cp-head', switcher, h('span', { style: { flex: 1 } }),
      h('button.icon-btn', { title: 'Show the window on this Mac', on: { click: () => api('POST', '/api/computer/focus', body) } }, icon('open')),
      h('button.icon-btn', { title: 'Close', on: { click: () => toggleComputer(false) } }, icon('x'))),
    screen,
    h('div.cp-url', meta.url || ' '),
    h('div.cp-activity', control ? `You're in control. ${b.name} waits until you press I'm done.` : (working ? (working.status || 'Working') : (c.activity || 'Idle'))),
    control && !c.teach && h('div.cp-banner',
      h('div', c.takeover?.reason || 'You took control.'),
      h('div.hint', 'Do just that step. Click and scroll on the screen above and type below, or use the window on your Mac.'),
      h('div.hstack', h('button.btn.primary', { on: { click: () => api('POST', '/api/computer/done', body) } }, "I'm done"))),
    control && h('div.cp-type', h('button.icon-btn', { title: 'Back', on: { click: () => send({ type: 'back' }) } }, icon('back')), urlBox),
    control && h('div.cp-type', typeBox),
    c.teach && h('div.cp-teach',
      h('div', h('span.rec'), ' ', h('b', 'Watching and learning')),
      h('div', c.teach.goal),
      h('div.hint', 'Do the task once. Recording stops by itself after ten minutes. No audio is captured.'),
      h('div.hstack', h('button.btn.primary', { on: { click: () => api('POST', '/api/computer/teach/stop', body).then(() => toast('Drafting a skill from what you showed it')) } }, 'Stop'))),
    !control && h('div.cp-actions',
      h('button.btn', { on: { click: () => api('POST', '/api/computer/takeover', { ...body, reason: 'You took control' }) } }, icon('hand'), 'Take control'),
      h('button.btn', { on: { click: () => api('POST', '/api/computer/takeover', { ...body, reason: 'You took over in the window', focus: true }) } }, icon('open'), 'Take over'),
      h('button.btn.ghost', { title: 'Restart this computer’s browser', on: { click: () => api('POST', '/api/computer/restart', body).then(() => toast('Restarted')).then(poll) } }, icon('refresh'))),
    h('div.cp-files', `Files: ${c.workspace || ''}`),
  ].filter(Boolean));
  poll();
  schedule();
}
