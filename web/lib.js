// Shared UI helpers: API calls, DOM builder, Markdown, avatars, icons, modals, toasts.

export async function api(method, path, body, { raw = false, headers = {} } = {}) {
  const opts = { method, headers: { ...headers } };
  if (body instanceof Blob || body instanceof ArrayBuffer) opts.body = body;
  else if (body !== undefined) { opts.body = JSON.stringify(body); opts.headers['Content-Type'] = 'application/json'; }
  const r = await fetch(path, opts);
  if (raw) return r;
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `${r.status}`);
  return j;
}

// h('div.cls#id', {attrs, on: {click}}, ...children)
// Shortcut labels are written the Mac way; other keyboards get Ctrl, Alt and Shift.
const APPLE = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');
export const keys = (s) => (APPLE ? s : String(s).replace(/⌥Space on your Mac/, 'Ctrl+J').replace(/[⌘⌃]/g, 'Ctrl+').replace(/⇧/g, 'Shift+').replace(/⌥/g, 'Alt+').replace(/⌫/g, 'Backspace').replace(/\+(?=$|\s|\))/g, ''));
// The computer Tandem runs on ("Mac", "PC") and where it keeps secrets; set from the server's settings.
export const host = { machine: 'Mac', secrets: 'your Mac\'s Keychain' };
export const setHost = (s = {}) => { if (s.machine) host.machine = s.machine; if (s.secrets_where) host.secrets = s.secrets_where; };

export function h(tag, attrs, ...kids) {
  if (attrs == null || typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs)) { kids.unshift(attrs); attrs = {}; }
  const [, name = 'div', rest = ''] = tag.match(/^([a-z0-9-]*)(.*)$/i);
  const el = name === 'svg' ? document.createElementNS('http://www.w3.org/2000/svg', 'svg') : document.createElement(name || 'div');
  for (const m of rest.matchAll(/([.#])([\w-]+)/g)) m[1] === '.' ? el.classList.add(m[2]) : (el.id = m[2]);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'on') for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
    else if (k === 'class') el.className += ' ' + v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'html') el.innerHTML = v;
    else if (['value', 'checked', 'disabled', 'readOnly', 'selected', 'hidden', 'textContent'].includes(k)) el[k] = v;
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : k === 'title' ? keys(v) : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(name === 'kbd' || name === 'small' ? keys(kid) : String(kid)));
  }
  return el;
}

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Small, safe Markdown subset.
export function md(src) {
  const blocks = [];
  let s = String(src || '').replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    blocks.push(`<pre><code>${esc(code.replace(/\n$/, ''))}</code></pre>`);
    return `\u0000${blocks.length - 1}\u0000`;
  });
  const inline = (t) => esc(t)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+|\/files\?[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
  const out = [];
  const lines = s.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\u0000\d+\u0000$/.test(line.trim())) { out.push(blocks[Number(line.trim().slice(1, -1))]); continue; }
    if (/^#{1,3}\s/.test(line)) { out.push(`<h3>${inline(line.replace(/^#+\s/, ''))}</h3>`); continue; }
    if (/^>\s?/.test(line)) { out.push(`<blockquote>${inline(line.replace(/^>\s?/, ''))}</blockquote>`); continue; }
    if (/^\s*[-*•]\s+/.test(line) || /^\s*\d+[.)]\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const items = [];
      while (i < lines.length && (ordered ? /^\s*\d+[.)]\s+/ : /^\s*[-*•]\s+/).test(lines[i])) {
        items.push(`<li>${inline(lines[i].replace(/^\s*([-*•]|\d+[.)])\s+/, ''))}</li>`); i++;
      }
      i--;
      out.push(ordered ? `<ol>${items.join('')}</ol>` : `<ul>${items.join('')}</ul>`);
      continue;
    }
    if (/^\|.*\|$/.test(line.trim()) && /^\|?[\s:-]+\|/.test(lines[i + 1] || '')) {
      const row = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const head = row(line); i += 2;
      const body = [];
      while (i < lines.length && /^\|.*\|$/.test(lines[i].trim())) { body.push(row(lines[i])); i++; }
      i--;
      out.push(`<table><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr>${body.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</table>`);
      continue;
    }
    if (!line.trim()) { out.push(''); continue; }
    out.push(`<p>${inline(line)}</p>`);
  }
  return out.join('\n').replace(/<\/p>\n<p>/g, '<br>');
}

// ---- Avatars ------------------------------------------------------------------------
const SHAPE_PATHS = {
  circle: '<circle cx="50" cy="50" r="46"/>',
  squircle: '<path d="M50 4C88 4 96 12 96 50s-8 46-46 46S4 88 4 50 12 4 50 4z"/>',
  hexagon: '<path d="M50 3l41 23.5v47L50 97 9 73.5v-47z"/>',
  diamond: '<path d="M50 3l47 47-47 47L3 50z" transform="rotate(0 50 50)"/>',
  blob: '<path d="M73 13c15 9 24 26 21 44s-17 34-35 37-37-6-46-22S6 32 20 19 58 4 73 13z"/>',
  star: '<path d="M50 4l12.5 28.5L94 36l-23 21 6.5 31L50 72 22.5 88 29 57 6 36l31.5-3.5z"/>',
};
export const SHAPES = Object.keys(SHAPE_PATHS);
export const COLORS = ['#6d5dfc', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#8b5cf6', '#14b8a6', '#64748b', '#111827'];

export function avatar(bot, size = 28, { blink = true, busy = false } = {}) {
  const wrap = h(`span.av${blink ? '.blink' : ''}${busy ? '.busy' : ''}`, { style: { width: `${size}px`, height: `${size}px` } });
  if (bot?.id) wrap.dataset.bot = bot.id;
  if (!bot) { wrap.innerHTML = `<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="46" fill="var(--active)"/></svg>`; return wrap; }
  if (bot.avatar) { wrap.append(h('img', { src: bot.avatar, alt: '' })); return wrap; }
  // A Bot is a coloured shape with a face whose eyes follow your cursor (see alive.js).
  const eyeY = bot.shape === 'star' ? 52 : 47;
  const gap = bot.shape === 'diamond' ? 11 : 13;
  const delay = (Math.random() * 4).toFixed(2);
  wrap.innerHTML = `<svg viewBox="0 0 100 100"><g class="body" fill="${esc(bot.color)}">${SHAPE_PATHS[bot.shape] || SHAPE_PATHS.circle}</g>
    <g class="eyes" style="animation-delay:-${delay}s"><ellipse cx="${50 - gap}" cy="${eyeY}" rx="7.5" ry="10" fill="#fff"/><ellipse cx="${50 + gap}" cy="${eyeY}" rx="7.5" ry="10" fill="#fff"/>
    <g class="pupils"><circle cx="${50 - gap}" cy="${eyeY + 1.5}" r="4.2" fill="#111"/><circle cx="${50 + gap}" cy="${eyeY + 1.5}" r="4.2" fill="#111"/>
    <circle cx="${50 - gap + 1.6}" cy="${eyeY - .4}" r="1.2" fill="#fff" opacity=".9"/><circle cx="${50 + gap + 1.6}" cy="${eyeY - .4}" r="1.2" fill="#fff" opacity=".9"/></g></g></svg>`;
  return wrap;
}

// Two or three Bots stacked, for group chats.
export function groupAvatar(bots, size = 28) {
  const g = h('span.av-group', { style: { width: `${size}px`, height: `${size}px` } });
  const list = bots.slice(0, 3);
  const s = Math.round(size * (list.length > 2 ? 0.62 : 0.7));
  const pos = list.length > 2 ? [[0, 0], [size - s, size * 0.12], [size * 0.18, size - s]] : [[0, 0], [size - s, size - s]];
  list.forEach((b, i) => { const a = avatar(b, s); a.style.left = `${pos[i][0]}px`; a.style.top = `${pos[i][1]}px`; g.append(a); });
  return g;
}

export function userAvatar(size = 28, name = '') {
  const initials = String(name).trim().split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase() || 'ME';
  return h('span.initials', { style: { width: `${size}px`, height: `${size}px` } }, initials);
}

// Real app logos (bundled in /logos, see scripts/fetch-logos.mjs), with a letter tile as fallback.
export const LOGOS = {};
export async function loadLogos() {
  try { Object.assign(LOGOS, await (await fetch('/logos/index.json')).json()); } catch {}
}
export const logo = (app, size = 32) => {
  const key = app.catalog_id && app.catalog_id !== 'custom' ? app.catalog_id : app.id;
  const src = LOGOS[key] || LOGOS[app.id];
  if (src) return h('span.logo.real', { style: { width: `${size}px`, height: `${size}px`, borderRadius: `${Math.round(size * 0.26)}px` } },
    h('img', { src, alt: '', loading: 'lazy', draggable: false }));
  return h('span.logo', { style: { background: app.color || '#64748b', width: `${size}px`, height: `${size}px`, fontSize: `${Math.round(size * .42)}px` } },
    (app.name || '?').replace(/^(Google|Microsoft|Meta)\s/, '')[0]);
};

// ---- Icons (inline, stroke) ----------------------------------------------------------
const I = {
  table: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M3.5 9.5h17M3.5 14.5h17M9.5 9.5v10"/>',
  code: '<path d="M8.5 8 4.5 12l4 4M15.5 8l4 4-4 4M13.5 5.5l-3 13"/>',
  slides: '<rect x="3.5" y="4.5" width="17" height="12" rx="2"/><path d="M12 16.5v3M8.5 19.5h7"/>',
  bolt: '<path d="M13 3 5.5 13.5H12L11 21l7.5-10.5H12z"/>',
  copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 8.5V6a1.5 1.5 0 0 0-1.5-1.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  send: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  stop: '<rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor"/>',
  clip: '<path d="M21 11.5 12.5 20a5 5 0 0 1-7-7l8.5-8.5a3.5 3.5 0 0 1 5 5L10.5 18a2 2 0 0 1-3-3L15 7.5"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
  monitor: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  apps: '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>',
  book: '<path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z"/><path d="M4 19V5"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  back: '<path d="M15 6l-6 6 6 6"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.8 3.5-5.5 6.5-5.5s5.7 1.7 6.5 5.5"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14.6c2 .7 3.2 2.4 3.5 5.4"/>',
  template: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/>',
  more: '<circle cx="5" cy="12" r="1.3" fill="currentColor"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/><circle cx="19" cy="12" r="1.3" fill="currentColor"/>',
  hand: '<path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V12M11 11.5v-8a1.5 1.5 0 0 1 3 0v8M14 11.5V5a1.5 1.5 0 0 1 3 0v8M17 9.5a1.5 1.5 0 0 1 3 0V15a7 7 0 0 1-7 7h-1a7 7 0 0 1-5.5-2.7L3 15.5a1.6 1.6 0 0 1 2.5-2L8 16"/>',
  rec: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3.5" fill="currentColor"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9M17 6l3 3M15 8l2 2"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/>',
  open: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  up: '<path d="M12 19V5M5 12l7-7 7 7"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
  page: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-9 9"/>',
  sidebar: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
  download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  activity: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  phone: '<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z"/>',
  hangup: '<path d="M3 15c5-5 13-5 18 0l-2.5 2.5-3.5-1.5v-3a10 10 0 0 0-6 0v3l-3.5 1.5z"/>',
  home: '<path d="M4 11l8-7 8 7v8a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1z"/>',
  target: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="1" fill="currentColor"/>',
  inbox: '<path d="M3 13h5l1.5 3h5L16 13h5"/><path d="M5 5h14l2 8v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-5z"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3.5 6.5 8.5 6.5 8.5-6.5"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .8-1 1.5v.4M12 17h.01"/>',
  plug: '<path d="M9 2v6M15 2v6M6 8h12v4a6 6 0 0 1-12 0zM12 18v4"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  sparkle: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/>',
};
export function icon(name) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('width', '16');
  s.setAttribute('height', '16');
  s.setAttribute('fill', 'none');
  s.setAttribute('stroke', 'currentColor');
  s.setAttribute('stroke-width', '1.8');
  s.setAttribute('stroke-linecap', 'round');
  s.setAttribute('stroke-linejoin', 'round');
  s.innerHTML = I[name] || '';
  return s;
}

// ---- Toasts, modals, menus -----------------------------------------------------------
export function toast(text, kind = '') {
  const t = h(`div.toast${kind ? '.' + kind : ''}`, text);
  document.getElementById('toasts').append(t);
  setTimeout(() => t.remove(), 3400);
}

export function modal({ title, body, actions = [], wide = false, onClose, cls = '' }) {
  const root = document.getElementById('modal-root');
  const close = () => { bg.remove(); onClose?.(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  const box = h(`div.modal${wide ? '.wide' : ''}${cls ? '.' + cls : ''}`,
    title && h('div.modal-h', title, h('button.icon-btn', { on: { click: close }, 'aria-label': 'Close' }, icon('x'))),
    h('div.modal-b', body),
    actions.length > 0 && h('div.modal-f', actions.map((a) => h(`button.btn${a.primary ? '.primary' : ''}${a.danger ? '.danger' : ''}`, {
      on: { click: async () => { try { if ((await a.onClick?.(close)) !== false) close(); } catch (e) { toast(e.message, 'bad'); } } },
    }, a.label))));
  const bg = h('div.modal-bg', { on: { mousedown: (e) => { if (e.target === bg) close(); } } }, box);
  root.append(bg);
  setTimeout(() => box.querySelector('input,textarea')?.focus(), 30);
  return { close, box };
}

export function confirm(text, { danger = true, label = 'Delete' } = {}) {
  return new Promise((resolve) => {
    modal({ title: 'Are you sure?', body: h('p', { style: { margin: 0 } }, text), onClose: () => resolve(false),
      actions: [{ label: 'Cancel', onClick: () => resolve(false) }, { label, danger, primary: !danger, onClick: () => resolve(true) }] });
  });
}

export function menu(x, y, items) {
  document.querySelector('.ctx-menu')?.remove();
  const m = h('div.ctx-menu', items.map((it) => it === '-' ? h('hr') :
    h(`button${it.danger ? '.danger' : ''}`, { on: { click: () => { m.remove(); it.onClick(); } } }, it.label)));
  document.body.append(m);
  const r = m.getBoundingClientRect();
  m.style.left = `${Math.min(x, innerWidth - r.width - 8)}px`;
  m.style.top = `${Math.min(y, innerHeight - r.height - 8)}px`;
  setTimeout(() => document.addEventListener('mousedown', function off(e) {
    if (!m.contains(e.target)) { m.remove(); document.removeEventListener('mousedown', off); }
  }), 0);
}

export function sw(checked, onChange) {
  return h('label.switch', h('input', { type: 'checkbox', checked, on: { change: (e) => onChange(e.target.checked) } }), h('span'));
}

export const time = (ts) => {
  const d = new Date(ts);
  const today = new Date().toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
};
export const ago = (ts) => {
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};
export const fileUrl = (p, download) => `/files?path=${encodeURIComponent(p)}${download ? '&download=1' : ''}`;
