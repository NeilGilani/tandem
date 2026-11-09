// Tandem web app: sidebar, conversations, cards, composer, palette, shortcuts.
import { api, h, md, avatar, groupAvatar, userAvatar, icon, toast, modal, confirm, menu, time, fileUrl, SHAPES, COLORS, logo, esc } from './lib.js';
import { S, on, refresh, bot, chat, dmOf, runsIn, go, parseRoute, toggleComputer, connectEvents, comp } from './store.js';
import { renderComputer } from './computer.js';
import { openBotDrawer } from './drawer.js';
import { renderApps, renderSkills, renderSettings, renderTemplates } from './pages.js';

const $sidebar = document.getElementById('sidebar');
const $main = document.getElementById('main');
const $app = document.getElementById('app');

// ---------- Small helpers -------------------------------------------------------------------
const dur = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`; };
const shortTime = (ts) => {
  const d = new Date(ts), now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  if (now - d < 6 * 864e5) return d.toLocaleDateString([], { weekday: 'short' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
};
const dayLabel = (ts) => {
  const d = new Date(ts), now = new Date();
  const t = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return `Today ${t}`;
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `Yesterday ${t}`;
  return `${d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })} ${t}`;
};
const chipFor = (b) => b ? h('span.chip', avatar(b, 16), b.name) : null;
const userName = () => S.settings.user_name || 'You';
const seenKey = (id) => `tandem.seen.${id}`;
const getSeen = (id) => { try { return Number(localStorage.getItem(seenKey(id)) || 0); } catch { return 0; } };
const markSeen = (id) => { try { localStorage.setItem(seenKey(id), String(Date.now())); } catch {} };

function applyTheme() {
  const t = S.settings.theme || 'system';
  if (t === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
}

// ---------- Sidebar ---------------------------------------------------------------------------
let renaming = null;
let showHidden = false;
let sideQuery = '';
let compact = (() => { try { return localStorage.getItem('tandem.compact') === '1'; } catch { return false; } })();

function chatRow(c) {
  const isGroup = c.kind === 'group';
  const b = isGroup ? null : bot(c.bot_ids[0]);
  if (!isGroup && !b) return null;
  const active = S.route.name === 'chat' && S.route.id === c.id;
  const run = runsIn(c.id)[0];
  const last = c.last;
  const unread = !active && last && last.author !== 'user' && last.created > getSeen(c.id);
  const name = isGroup ? c.name : b.name;
  if (!isGroup && renaming === b.id) {
    const input = h('input', { value: b.name, on: {
      keydown: async (e) => {
        if (e.key === 'Enter') { await api('PATCH', `/api/bots/${b.id}`, { name: input.value.trim() || b.name }); renaming = null; renderSidebar(); }
        if (e.key === 'Escape') { renaming = null; renderSidebar(); }
      },
      blur: () => { renaming = null; renderSidebar(); },
    } });
    setTimeout(() => { input.focus(); input.select(); });
    return h('div.bot-row', avatar(b, 34), input);
  }
  const preview = run ? run.status : last ? (last.author === 'user' ? `You: ${last.text}` : last.text) : (b?.label || 'New Bot');
  return h(`button.bot-row${active ? '.active' : ''}`, {
    'data-chat': c.id,
    on: {
      click: () => go(`#/chat/${c.id}`),
      dblclick: () => { if (b) { renaming = b.id; renderSidebar(); } },
      contextmenu: (e) => { e.preventDefault(); isGroup ? groupMenu(c, e.clientX, e.clientY) : botMenu(b, e.clientX, e.clientY); },
    },
  },
  isGroup ? groupAvatar(c.bot_ids.map(bot).filter(Boolean), 34) : avatar(b, 34, { blink: !!run }),
  h('div.t',
    h('div.n', h('b', name), h('time', run ? '' : last ? shortTime(last.created) : '')),
    h(`div.p${run ? '.working' : ''}`, preview)),
  unread ? h('span.unread') : null);
}

export function botMenu(b, x, y) {
  const sections = [...new Set([...S.sections.map((s) => s.name), ...S.bots.map((v) => v.section).filter(Boolean)])];
  menu(x, y, [
    { label: 'View conversation details', onClick: () => openBotDrawer(b.id) },
    { label: 'Rename Bot', onClick: () => { renaming = b.id; renderSidebar(); } },
    { label: b.pinned ? 'Unpin' : 'Pin', onClick: () => api('PATCH', `/api/bots/${b.id}`, { pinned: !b.pinned }) },
    ...(b.is_primary ? [{ label: 'Replace with different Bot', onClick: () => pickPrimary() }] : [{ label: 'Make primary Bot', onClick: () => api('POST', `/api/bots/${b.id}/primary`) }]),
    '-',
    { label: 'Move to new section…', onClick: () => promptText('New section', 'Section name', '').then((n) => n && api('PATCH', `/api/bots/${b.id}`, { section: n })) },
    ...sections.filter((s) => s !== b.section).map((s) => ({ label: `Move to ${s}`, onClick: () => api('PATCH', `/api/bots/${b.id}`, { section: s }) })),
    ...(b.section ? [{ label: 'Remove from section', onClick: () => api('PATCH', `/api/bots/${b.id}`, { section: '' }) }] : []),
    '-',
    { label: 'Duplicate', onClick: async () => { const r = await api('POST', `/api/bots/${b.id}/duplicate`); await refresh(); go(`#/chat/${r.chat.id}`); } },
    { label: b.hidden ? 'Show in sidebar' : 'Hide from sidebar', onClick: () => api('PATCH', `/api/bots/${b.id}`, { hidden: !b.hidden }) },
    { label: 'Delete', danger: true, onClick: () => deleteBot(b) },
  ]);
}

async function deleteBot(b) {
  if (!await confirm(`Delete ${b.name}? This erases its profile, conversations, memory, routines and attachments. It can't be undone. Files and sign-ins on the shared computer aren't removed.`)) return;
  await api('DELETE', `/api/bots/${b.id}`);
  await refresh();
  go('#/');
}

function pickPrimary() {
  let pick = null;
  const list = h('div.list', S.bots.map((b) => h('label.list-row', h('input', { type: 'radio', name: 'p', on: { change: () => (pick = b.id) } }), avatar(b, 24), h('span.grow', b.name))));
  modal({ title: 'Choose your primary Bot', body: [h('p.hint', { style: { margin: 0 } }, 'Your primary Bot is your main point of contact. Imported memory goes to it.'), list],
    actions: [{ label: 'Cancel' }, { label: 'Confirm', primary: true, onClick: () => pick && api('POST', `/api/bots/${pick}/primary`) }] });
}

export function promptText(title, label, value = '', { multiline = false } = {}) {
  return new Promise((resolve) => {
    const input = multiline ? h('textarea.textarea', { value }) : h('input.input', { value });
    modal({ title, body: h('div.field', h('label', label), input), onClose: () => resolve(null),
      actions: [{ label: 'Cancel' }, { label: 'Save', primary: true, onClick: () => resolve(input.value.trim()) }] });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !multiline) e.target.closest('.modal').querySelector('.btn.primary').click(); });
  });
}

function sidebarOrder() {
  const q = sideQuery.trim().toLowerCase();
  const match = (c) => !q || (c.kind === 'group' ? c.name : bot(c.bot_ids[0])?.name || '').toLowerCase().includes(q);
  const dms = S.chats.filter((c) => c.kind === 'dm' && bot(c.bot_ids[0])).filter(match);
  const recency = (c) => Math.max(c.last?.created || 0, runsIn(c.id).length ? Date.now() : 0, bot(c.bot_ids[0])?.created || 0);
  const visible = dms.filter((c) => !bot(c.bot_ids[0]).hidden);
  const hidden = dms.filter((c) => bot(c.bot_ids[0]).hidden);
  const primary = visible.filter((c) => bot(c.bot_ids[0]).is_primary);
  const pinned = visible.filter((c) => { const b = bot(c.bot_ids[0]); return b.pinned && !b.is_primary; }).sort((a, b) => recency(b) - recency(a));
  const rest = visible.filter((c) => { const b = bot(c.bot_ids[0]); return !b.pinned && !b.is_primary; });
  const groups = S.chats.filter((c) => c.kind === 'group').filter(match);
  const sections = [...new Set(rest.map((c) => bot(c.bot_ids[0]).section).filter(Boolean))];
  const loose = [...rest.filter((c) => !bot(c.bot_ids[0]).section), ...groups].sort((a, b) => recency(b) - recency(a));
  return { primary, pinned, sections: sections.map((s) => [s, rest.filter((c) => bot(c.bot_ids[0]).section === s).sort((a, b) => recency(b) - recency(a))]), loose, hidden };
}
const flatOrder = () => { const o = sidebarOrder(); return [...o.primary, ...o.pinned, ...o.sections.flatMap(([, l]) => l), ...o.loose]; };

function renderSidebar() {
  const o = sidebarOrder();
  const keepFocus = document.activeElement?.id === 'sb-q';
  const search = h('input#sb-q', { placeholder: 'Search', value: sideQuery, on: {
    input: (e) => { sideQuery = e.target.value; renderSidebar(); },
    keydown: (e) => {
      if (e.key === 'Enter') { const first = flatOrder()[0]; if (first) { sideQuery = ''; go(`#/chat/${first.id}`); } }
      if (e.key === 'Escape') { sideQuery = ''; e.target.blur(); renderSidebar(); }
    },
  } });

  $sidebar.replaceChildren(
    h('div.sb-top',
      h('div.brand', h('img', { src: '/icon.svg', alt: '' }), 'Tandem'),
      h('button.icon-btn', { title: 'Compact sidebar (⌘B)', on: { click: toggleCompact } }, icon('sidebar')),
      h('button.icon-btn', { title: 'New Bot (⌘N)', on: { click: (e) => menu(e.clientX, e.clientY, [
        { label: 'Create a Bot', onClick: newBot },
        { label: 'New group chat', onClick: () => newGroup() },
        { label: 'Bot templates', onClick: () => go('#/templates') },
      ]) } }, icon('plus'))),
    h('label.sb-search', icon('search'), search, h('kbd', '⌘K')),
    h('div.sb-scroll',
      S.bots.length === 0 && h('div.hint', { style: { padding: '8px 10px' } }, 'No Bots yet.'),
      o.primary.map(chatRow),
      o.pinned.length > 0 && [h('div.sb-label', 'Pinned'), o.pinned.map(chatRow)],
      o.sections.map(([name, list]) => [h('div.sb-label', name), list.map(chatRow)]),
      o.loose.length > 0 && [(o.primary.length || o.pinned.length || o.sections.length) ? h('div.sb-label', 'Bots') : null, o.loose.map(chatRow)],
      o.hidden.length > 0 && [h('div.sb-label', h('button', { style: { marginLeft: 0 }, on: { click: () => { showHidden = !showHidden; renderSidebar(); } } }, `${showHidden ? 'Hide' : 'Show'} hidden Bots (${o.hidden.length})`)),
        showHidden && o.hidden.map(chatRow)]),
    h('div.sb-foot',
      h(`button.foot-row${S.route.name === 'apps' ? '.me' : ''}`, { on: { click: () => go('#/apps') } }, icon('apps'), 'Connect apps'),
      h(`button.foot-row${S.route.name === 'skills' ? '.me' : ''}`, { on: { click: () => go('#/skills') } }, icon('book'), 'Skills'),
      h('button.foot-row.me', { on: { click: (e) => menu(e.clientX, e.clientY - 150, [
        { label: 'Settings', onClick: () => go('#/settings') },
        { label: 'Bot templates', onClick: () => go('#/templates') },

        { label: 'Keyboard shortcuts', onClick: showShortcuts },
      ]) } }, userAvatar(26, userName()), userName())),
  );
  if (keepFocus) { const el = document.getElementById('sb-q'); el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
}

function toggleCompact() {
  compact = !compact;
  try { localStorage.setItem('tandem.compact', compact ? '1' : '0'); } catch {}
  $app.classList.toggle('compact', compact);
}

function groupMenu(g, x, y) {
  menu(x, y, [
    { label: 'Rename', onClick: () => promptText('Rename group', 'Name', g.name).then((n) => n && api('PATCH', `/api/chats/${g.id}`, { name: n })) },
    { label: 'Edit members', onClick: () => newGroup(g) },
    { label: 'Delete group', danger: true, onClick: async () => { if (await confirm(`Delete "${g.name}"?`)) { await api('DELETE', `/api/chats/${g.id}`); go('#/'); } } },
  ]);
}

// ---------- New Bot / group -------------------------------------------------------------------
export function newBot() {
  let shape = SHAPES[S.bots.length % SHAPES.length], color = COLORS[S.bots.length % COLORS.length];
  const name = h('input.input', { placeholder: 'Name' });
  const preview = h('div');
  const shapes = h('div.shape-pick');
  const colors = h('div.color-pick');
  const draw = () => {
    preview.replaceChildren(avatar({ name: name.value || '?', shape, color }, 72, { blink: true }));
    shapes.replaceChildren(...SHAPES.map((s) => h(`button${s === shape ? '.on' : ''}`, { type: 'button', on: { click: () => { shape = s; draw(); } } }, avatar({ shape: s, color }, 32))));
    colors.replaceChildren(...COLORS.map((c) => h(`button${c === color ? '.on' : ''}`, { type: 'button', style: { background: c }, on: { click: () => { color = c; draw(); } } })));
  };
  draw();
  const create = async () => {
    if (!name.value.trim()) { toast('Give your Bot a name', 'bad'); return false; }
    const r = await api('POST', '/api/bots', { name: name.value.trim(), shape, color });
    await refresh();
    go(`#/chat/${r.chat.id}`);
  };
  const m = modal({ title: 'Create New Bot', body: [
    h('div', { style: { display: 'grid', justifyItems: 'center', gap: '12px' } }, preview, name),
    h('div.field', h('label', 'Shape'), shapes),
    h('div.field', h('label', 'Color'), colors),
  ], actions: [{ label: 'Cancel' }, { label: 'Create', primary: true, onClick: create }] });
  name.addEventListener('keydown', async (e) => { if (e.key === 'Enter' && (await create()) !== false) m.close(); });
}

export function newGroup(existing) {
  const picked = new Set(existing?.bot_ids || []);
  const name = h('input.input', { value: existing?.name || '', placeholder: 'Named after its members if left empty' });
  const list = h('div.list', S.bots.map((b) => h('label.list-row',
    h('input', { type: 'checkbox', checked: picked.has(b.id), on: { change: (e) => e.target.checked ? picked.add(b.id) : picked.delete(b.id) } }),
    avatar(b, 26), h('span.grow', b.name, b.label && h('small', b.label)))));
  modal({ title: existing ? 'Edit group' : 'New group chat', body: [
    h('div.field', h('label', 'To: two to six Bots'), list),
    h('div.field', h('label', 'Name'), name),
  ], actions: [{ label: 'Cancel' }, { label: existing ? 'Save' : 'Create', primary: true, onClick: async () => {
    if (picked.size < 2 || picked.size > 6) { toast('Pick two to six Bots', 'bad'); return false; }
    if (existing) await api('PATCH', `/api/chats/${existing.id}`, { botIds: [...picked], name: name.value.trim() || existing.name });
    else { const g = await api('POST', '/api/chats', { botIds: [...picked], name: name.value.trim() }); await refresh(); go(`#/chat/${g.id}`); }
  } }] });
}

// ---------- Chat view -------------------------------------------------------------------------
let replyTo = null;
let pendingFiles = [];
const expandedThreads = new Set();
const openDetails = new Set();

async function loadMessages(chatId) {
  const r = await api('GET', `/api/chats/${chatId}/messages`);
  S.messages[chatId] = r.messages;
  for (const run of r.runs) if (!S.runs.some((x) => x.id === run.id)) S.runs.push({ ...run, chatId });
}

function stepsBlock(m) {
  const steps = m.meta.steps;
  const tools = steps.filter((x) => x.k === 'tool').length;
  const label = `Worked for ${dur(m.meta.duration || 0)}${tools ? ` · ${tools} step${tools === 1 ? '' : 's'}` : ''}`;
  return h('details.steps', h('summary', label),
    h('ol', steps.map((x) => h(`li.${x.k}`, x.k === 'text' ? { html: md(x.t) } : x.t))));
}

function sysLine(m) {
  const k = m.meta?.kind;
  const b = bot(m.bot_id);
  if (k === 'memory') {
    const line = h('button.sys.clickable', { on: { click: () => { openDetails.has(m.id) ? openDetails.delete(m.id) : openDetails.add(m.id); paintMessages({ keepScroll: true }); } } },
      'Updated memory for', chipFor(b));
    return [line, openDetails.has(m.id) && m.meta.fact ? h('div.sys-detail', m.meta.fact) : null];
  }
  if (k === 'handoff' || k === 'handoff-reply') {
    const to = bot(k === 'handoff' ? m.meta.to : m.meta.from);
    const line = h('button.sys.clickable', { on: { click: () => { openDetails.has(m.id) ? openDetails.delete(m.id) : openDetails.add(m.id); paintMessages({ keepScroll: true }); } } },
      k === 'handoff' ? ['Sending to', chipFor(to)] : ['Message from', chipFor(to)]);
    return [line, openDetails.has(m.id) && m.meta.detail ? h('div.sys-detail', m.meta.detail) : null];
  }
  return h(`div.sys${m.meta?.error ? '.error' : ''}`, m.text);
}

function renderBotParts(m, isGroup, showWho) {
  const b = bot(m.bot_id);
  const parts = [];
  if (isGroup && showWho) parts.push(h('div.who', b?.name || 'Bot'));
  if (m.meta?.steps?.length > 0) parts.push(stepsBlock(m));
  if (m.meta?.browser && m.meta?.shot && m.text) parts.push(computerCard({ botId: m.bot_id, state: 'done', shot: fileUrl(m.meta.shot), text: null }));
  if (m.meta?.handoff && m.author === 'bot') parts.push(h('div.who', `From ${b?.name || 'a Bot'}`));
  if (m.text) parts.push(h('div.bubble', { html: md(m.text) }));
  if (m.card) parts.push(renderCard(m));
  if (Object.keys(m.reactions || {}).length) parts.push(h('div.reactions', Object.keys(m.reactions).map((e) => h('button', { on: { click: () => api('POST', `/api/messages/${m.id}/react`, { emoji: e }) } }, e))));
  return parts;
}

function messageRow(m, prev, isGroup, { inThread = false } = {}) {
  if (m.author === 'system') return sysLine(m);
  const me = m.author === 'user';
  const sameRun = prev && prev.author === m.author && prev.bot_id === m.bot_id && m.created - prev.created < 5 * 60e3;
  const showSideAv = isGroup && !me;
  const col = h('div.col',
    me ? [
      m.text ? h('div.bubble', { textContent: m.text }) : null,
      m.attachments?.length ? h('div.attach-list', m.attachments.map((a) => /\.(png|jpe?g|gif|webp)$/i.test(a.name)
        ? h('a.attach', { href: fileUrl(a.path), target: '_blank' }, h('img', { src: fileUrl(a.path), alt: a.name }))
        : h('a.attach', { href: fileUrl(a.path, true) }, icon('clip'), a.name))) : null,
      Object.keys(m.reactions || {}).length ? h('div.reactions', Object.keys(m.reactions).map((e) => h('button', { on: { click: () => api('POST', `/api/messages/${m.id}/react`, { emoji: e }) } }, e))) : null,
    ] : renderBotParts(m, isGroup, !sameRun));
  return h(`div.row${me ? '.me' : ''}${sameRun ? '' : '.gap'}`, { 'data-id': m.id },
    showSideAv ? h('div.side-av', sameRun ? null : avatar(bot(m.bot_id), 26)) : null,
    col,
    h('div.hover-tools',
      ['👍', '❤️', '👀', '✅'].map((e) => h('button', { title: 'React', on: { click: () => api('POST', `/api/messages/${m.id}/react`, { emoji: e }) } }, e)),
      !inThread && h('button', { title: 'Reply in thread', on: { click: () => { replyTo = m; renderComposer(); } } }, 'Reply'),
      m.text && h('button', { title: 'Copy', on: { click: () => { navigator.clipboard.writeText(m.text); toast('Copied'); } } }, 'Copy')));
}

function renderMessages(chatId) {
  const c = chat(chatId);
  const isGroup = c?.kind === 'group';
  const list = S.messages[chatId] || [];
  const roots = list.filter((m) => !m.parent_id);
  const byParent = {};
  for (const m of list) if (m.parent_id) (byParent[m.parent_id] ||= []).push(m);
  const out = [];
  let prev = null;
  for (const m of roots) {
    if (!prev || m.created - prev.created > 30 * 60e3) { out.push(h('div.daysep', dayLabel(m.created))); prev = null; }
    out.push(messageRow(m, prev && prev.author !== 'system' ? prev : null, isGroup));
    prev = m;
    const replies = byParent[m.id];
    if (replies?.length) {
      if (expandedThreads.has(m.id) || replies.length <= 2) out.push(h('div.thread', replies.map((r, i) => messageRow(r, replies[i - 1], isGroup, { inThread: true }))));
      else out.push(h('button.thread-toggle', { on: { click: () => { expandedThreads.add(m.id); paintMessages({ keepScroll: true }); } } }, `${replies.length} replies`));
    }
  }
  return out.flat();
}

// Live "working" rows, one per running Bot, with a live Computer card when it uses the browser.
function workingRows(chatId) {
  const runs = runsIn(chatId);
  const out = [];
  for (const r of runs) {
    const b = bot(r.botId);
    if (r.browser) {
      const cs = comp(r.botId);
      const ctl = cs.control === 'user';
      out.push(h('div.row.gap', h('div.col', computerCard({
        botId: r.botId, state: ctl ? 'control' : 'working', live: true,
        text: ctl ? (cs.takeover?.reason || 'You have control') : r.status,
      }))));
    }
    out.push(h('div.working', avatar(b, 22, { blink: true }), h('span.st.shimmer', r.status || 'Thinking'), h('span.el', dur(Date.now() - r.started)),
      h('button.btn.ghost', { style: { height: '24px', fontSize: '12px', padding: '0 8px' }, on: { click: () => api('POST', `/api/chats/${chatId}/stop`) } }, 'Stop')));
  }
  return out;
}

function computerCard({ botId, state, shot, text, live = false }) {
  const pill = state === 'working' ? h('span.pill.warn.spin', 'Working') : state === 'control' ? h('span.pill.warn', "You're in control") : h('span.pill.good', 'Done');
  const liveUrl = liveShots[botId];
  const img = h('img', { alt: '', src: live ? (liveUrl || '') : (shot || ''), hidden: (live && !liveUrl) || (!live && !shot) });
  if (live) img.dataset.live = botId;
  const body = { botId };
  const done = state === 'done';
  return h(`div.card.computer-card`, done ? { style: { cursor: 'pointer' }, title: 'Open this Bot’s computer', on: { click: () => { S.focusBot = botId; toggleComputer(true); } } } : {},
    h('div.card-h', 'Computer', pill),
    text ? h('div.card-b', h('div.card-title', text)) : null,
    (live || shot) ? h('div.shot', img, live && !liveUrl ? h('div.empty', 'Connecting to the computer') : null) : null,
    done ? h('div', { style: { height: '12px' } }) : h('div.card-actions',
      state === 'control'
        ? [h('button.btn.primary', { on: { click: () => api('POST', '/api/computer/done', body) } }, "I'm done"), h('button.btn', { on: { click: () => api('POST', '/api/computer/focus', body) } }, 'Show window')]
        : [h('button.btn.primary', { on: { click: () => api('POST', '/api/computer/takeover', { ...body, reason: 'You took over', focus: true }) } }, 'Take over'),
          h('button.btn', { on: { click: () => { S.focusBot = botId; toggleComputer(true); } } }, state === 'working' ? 'Watch' : 'Open computer')]));
}

// Poll each live computer card's screen while its Bot is working here.
const liveShots = {};
setInterval(async () => {
  if (document.hidden) return;
  const ids = [...new Set([...document.querySelectorAll('img[data-live]')].map((i) => i.dataset.live))];
  for (const id of ids) {
    try {
      const r = await fetch(`/api/computer/screenshot?bot=${encodeURIComponent(id)}`, { cache: 'no-store' });
      if (!r.ok) continue;
      const url = URL.createObjectURL(await r.blob());
      const old = liveShots[id];
      liveShots[id] = url;
      document.querySelectorAll(`img[data-live="${id}"]`).forEach((i) => { i.src = url; i.hidden = false; i.parentElement.querySelector('.empty')?.remove(); });
      if (old) setTimeout(() => URL.revokeObjectURL(old), 2000);
    } catch {}
  }
}, 1500);

let $messages, $working, $composer, $teach, currentChatId = null;

function paintMessages({ keepScroll = false } = {}) {
  if (!$messages || !currentChatId) return;
  const atBottom = $messages.scrollHeight - $messages.scrollTop - $messages.clientHeight < 140;
  const prev = $messages.scrollTop;
  const list = S.messages[currentChatId] || [];
  $working = h('div', workingRows(currentChatId));
  $messages.replaceChildren(h('div.msg-wrap', list.length || runsIn(currentChatId).length ? renderMessages(currentChatId) : emptyChat(currentChatId), $working));
  if (atBottom || !keepScroll) $messages.scrollTop = $messages.scrollHeight; else $messages.scrollTop = prev;
  markSeen(currentChatId);
}

function paintWorking() {
  if (!$working || !currentChatId) return;
  const atBottom = $messages.scrollHeight - $messages.scrollTop - $messages.clientHeight < 140;
  $working.replaceChildren(...workingRows(currentChatId));
  if (atBottom) $messages.scrollTop = $messages.scrollHeight;
}

function emptyChat(chatId) {
  const c = chat(chatId);
  if (c?.kind === 'group') return h('div.empty', { style: { padding: '80px 0' } }, h('div', groupAvatar(c.bot_ids.map(bot).filter(Boolean), 64),
    h('h2', c.name), h('p', 'Write normally and the Bots decide who responds, or @mention one to give it ownership.')));
  const b = bot(c?.bot_ids[0]);
  const starters = ['Your job is to triage my inbox every morning and draft replies. Remember that.', "Every weekday at 8am, send me a brief of today's meetings.", 'Research the 10 best-funded startups in my space and put them in a sheet.'];
  return h('div.empty', { style: { padding: '72px 0 24px' } }, h('div', avatar(b, 76, { blink: true }), h('h2', b?.name),
    h('p', 'Tell it its job, which apps to use, and when to check with you. Then give it a real first task.'),
    h('div.starters', starters.map((t) => h('button', { on: { click: () => { const ta = $composer.querySelector('textarea'); ta.value = t; ta.dispatchEvent(new Event('input')); ta.focus(); } } }, t)))));
}

function renderTeachBar() {
  if (!$teach) return;
  const c = chat(currentChatId);
  const t = c?.kind === 'dm' ? comp(c.bot_ids[0]).teach : null;
  if (!t) { $teach.hidden = true; return; }
  const b = bot(c.bot_ids[0]);
  $teach.hidden = false;
  $teach.replaceChildren(h('span.rec-dot'), h('span.t', `${b?.name} is watching and learning: ${t.goal}`), h('time', dur(Date.now() - t.started)),
    h('button.btn.primary', { style: { height: '26px' }, on: { click: () => api('POST', '/api/computer/teach/stop', { botId: b.id }).then(() => toast('Drafting a skill from what you showed it')) } }, 'Stop'));
}

function renderChat(chatId) {
  currentChatId = chatId;
  const c = chat(chatId);
  if (!c) { $main.replaceChildren(h('div.empty', 'Conversation not found.')); return; }
  const isGroup = c.kind === 'group';
  const b = isGroup ? null : bot(c.bot_ids[0]);
  const members = c.bot_ids.map(bot).filter(Boolean);

  const head = h('div.chat-head',
    h('button.icon-btn.back-btn', { on: { click: () => go('#/') } }, icon('back')),
    h('button.title', { title: 'Conversation details (⌘⇧I)', on: { click: () => isGroup ? newGroup(c) : openBotDrawer(b.id) } },
      isGroup ? groupAvatar(members, 24) : avatar(b, 24), h('span', isGroup ? c.name : b?.name)),
    h('div.spacer'),
    h('button.icon-btn', { title: 'Computer', on: { click: () => toggleComputer() } }, icon('monitor')),
    h('button.icon-btn', { title: 'More', on: { click: (e) => menu(e.clientX - 180, e.clientY + 12, [
      ...(!isGroup ? [{ label: 'View conversation details', onClick: () => openBotDrawer(b.id) }, { label: 'Routines', onClick: () => openBotDrawer(b.id, 'routines') }, { label: 'Library', onClick: () => openBotDrawer(b.id, 'library') }, { label: 'Teach a task', onClick: () => teachTask(b.id, chatId) }] : []),
      { label: 'Reset conversation', onClick: async () => { if (await confirm('Reset this conversation? Memory, files, routines and settings are kept.', { danger: false, label: 'Reset' })) api('POST', `/api/chats/${chatId}/reset`); } },
      ...(isGroup ? [{ label: 'Edit members', onClick: () => newGroup(c) }, { label: 'Delete group', danger: true, onClick: async () => { if (await confirm(`Delete "${c.name}"?`)) { await api('DELETE', `/api/chats/${c.id}`); go('#/'); } } }] : []),
    ]) } }, icon('more')));

  $messages = h('div.messages');
  $teach = h('div.teach-bar', { hidden: true });
  $composer = h('div.composer');
  $main.replaceChildren(head, $messages, $teach, $composer);
  renderComposer();
  renderTeachBar();
  if (S.messages[chatId]) paintMessages();
  loadMessages(chatId).then(() => { if (currentChatId === chatId) paintMessages(); });
}

export function teachTask(botId, chatId) {
  const goal = h('input.input', { placeholder: 'e.g. Download last month’s invoices from the billing portal' });
  modal({ title: 'Teach a task', body: [
    h('p.hint', { style: { margin: 0 } }, 'Describe the result. Then this Bot’s computer opens: do the task once there. Tandem records the screen for up to ten minutes, without audio, and drafts a skill. Keep passwords off screen.'),
    h('div.field', h('label', 'What should the result be?'), goal),
  ], actions: [{ label: 'Cancel' }, { label: 'Start', primary: true, onClick: async () => {
    if (!goal.value.trim()) { toast('Describe the result first', 'bad'); return false; }
    await api('POST', '/api/computer/teach/start', { chatId, botId, goal: goal.value.trim() });
  } }] });
}

// ---------- Viewer ------------------------------------------------------------------------------
export function openViewer({ title, ref, kind }) {
  const isUrl = /^https?:/.test(ref);
  if (isUrl) return window.open(ref, '_blank', 'noopener');
  const url = fileUrl(ref);
  let body;
  if (kind === 'image' || /\.(png|jpe?g|gif|webp|svg)$/i.test(ref)) body = h('div.img-wrap', h('img', { src: url, alt: title }));
  else if (/\.(md|txt|csv|json|log)$/i.test(ref)) {
    body = h('div.md', h('div', 'Loading…'));
    fetch(url).then((r) => r.text()).then((t) => { body.firstChild.innerHTML = /\.md$/i.test(ref) ? md(t) : `<pre style="white-space:pre-wrap">${esc(t)}</pre>`; });
  } else body = h('iframe', { src: url, title });
  const v = h('div.viewer',
    h('div.viewer-h', h('span.t', title || ref.split('/').pop()),
      h('a.btn', { href: fileUrl(ref, true) }, icon('download'), 'Download'),
      h('button.icon-btn', { title: 'Close', on: { click: () => v.remove() } }, icon('x'))),
    body);
  document.body.append(v);
  const esc2 = (e) => { if (e.key === 'Escape') { v.remove(); document.removeEventListener('keydown', esc2); } };
  document.addEventListener('keydown', esc2);
}

// ---------- Cards -------------------------------------------------------------------------------
function cardAction(m, payload) {
  return api('POST', `/api/cards/${m.id}`, payload).catch((e) => toast(e.message, 'bad'));
}

function statusPill(status) {
  const map = { allowed: ['Allowed', 'good'], denied: ['Denied', 'bad'], expired: ['Expired', ''], answered: ['Answered', 'good'], saved: ['Saved', 'good'],
    dismissed: ['Not now', ''], connected: ['Connected', 'good'], 'signing-in': ['Signing in', 'warn'], sent: ['Sent', 'good'], discarded: ['Discarded', ''], done: ['Done', 'good'], pending: ['Needs you', 'warn'] };
  const [label, cls] = map[status] || [status, ''];
  return h(`span.pill${cls ? '.' + cls : ''}`, label);
}

function renderCard(m) {
  const c = m.card;
  const pending = c.status === 'pending';
  const b = bot(m.bot_id);

  if (c.type === 'approval') {
    const commandCard = c.kind === 'command';
    const ruleCard = c.kind === 'rule';
    const details = c.command
      ? h('details.cmd-details', h('summary', 'Show command'), h('pre', c.command))
      : c.inputs && h('details.cmd-details', h('summary', 'Show details'), h('pre', c.inputs));
    if (!pending) {
      const word = { allowed: 'Allowed', denied: 'Denied', expired: 'Expired' }[c.status] || c.status;
      return h(`div.approval-done.${c.status}`, h('span', `${word}: ${c.summary}`), c.saved && h('span.saved', `· ${c.saved.replace(/^Saved: /, 'always allowed from now on')}`));
    }
    return h('div.card',
      h('div.card-h', commandCard ? 'Run a command on this computer?' : 'Approve this action?', statusPill('pending')),
      h('div.card-b',
        h('div.card-title', c.summary, c.site && h('span.hint', ` on ${c.site}`)),
        c.reason && h('div.hint', c.reason),
        (c.warnings || []).map((w) => h('div.warn', w)),
        details,
        c.expires && h('div.hint', `Expires at ${time(c.expires)}`)),
      h('div.card-actions',
        h('button.btn.primary', { on: { click: () => cardAction(m, { choice: 'allow' }) } }, c.allowAlways ? 'Allow once' : 'Allow'),
        c.allowAlways && h('button.btn', { on: { click: () => cardAction(m, { choice: 'always' }) } }, c.alwaysLabel || 'Always allow'),
        h('button.btn.ghost', { on: { click: () => cardAction(m, { choice: 'deny' }) } }, commandCard ? 'Skip' : ruleCard ? 'Not now' : 'Deny'),
        ruleCard && h('button.btn.ghost', { on: { click: () => go('#/settings/general') } }, 'Edit rule')));
  }

  if (c.type === 'draft') {
    const isChat = /slack|teams|discord|whatsapp|telegram|message|linkedin|x\b/i.test(c.app || '');
    const fields = { to: c.to, cc: c.cc, subject: c.subject, body: c.body };
    const inputs = {};
    const field = (k, label) => {
      inputs[k] = h('input.input', { value: fields[k] || '', disabled: !pending });
      return h('div.draft-field', h('label', label), inputs[k]);
    };
    inputs.body = h('textarea.textarea.draft-body', { value: c.body || '', rows: 8, disabled: !pending });
    const edits = () => Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, el.value]));
    if (!pending) {
      return h('div.card', h('div.card-h', `${c.app} draft`, statusPill(c.status)),
        h('div.card-b', h('div.card-title', c.subject || c.to), h('div', { style: { whiteSpace: 'pre-wrap' } }, (c.body || '').slice(0, 280) + ((c.body || '').length > 280 ? '…' : ''))));
    }
    return h('div.card.wide',
      h('div.card-h', `${c.app} draft`, h('span.pill.warn', 'Needs approval')),
      h('div.card-b', field('to', 'To'), (c.cc) && field('cc', 'Cc'), !isChat && field('subject', 'Subject'), inputs.body,
        c.thread && h('div.hint', `In reply to: ${c.thread}`)),
      h('div.card-actions',
        h('button.btn.primary', { on: { click: () => cardAction(m, { action: 'send', edits: edits() }) } }, isChat ? 'Send message' : 'Send'),
        h('button.btn', { on: { click: () => cardAction(m, { action: 'discard' }) } }, 'Discard'),
        h('button.btn.ghost', { style: { marginLeft: 'auto' }, on: { click: () => api('PATCH', `/api/bots/${m.bot_id}`, { drafts: 0 }).then(() => toast(`${b?.name} will send directly from now on`)) } }, 'Turn off drafts')));
  }

  if (c.type === 'question') {
    const answerBox = c.fields?.length ? c.fields.map((f) => h('div.field', h('label', f), h('input.input', { 'data-f': f }))) : (!c.options?.length ? [h('textarea.textarea', { rows: 3, 'data-free': 1, placeholder: 'Your answer' })] : []);
    const submit = (val) => {
      let answer = val;
      if (!answer) {
        const el = cardEl.querySelectorAll('[data-f]');
        answer = el.length ? [...el].map((e) => `${e.dataset.f}: ${e.value}`).join('\n') : cardEl.querySelector('[data-free]')?.value;
      }
      if (answer) cardAction(m, { answer });
    };
    if (!pending) return h('div.approval-done', h('span', `Answered: ${String(c.answer || '').slice(0, 160)}`));
    const cardEl = h('div.card.wide',
      h('div.card-h', 'Question', statusPill('pending')),
      h('div.card-b', h('div.card-title', { html: md(c.question) }), answerBox),
      h('div.card-actions', (c.options || []).map((o) => h('button.btn', { on: { click: () => submit(o) } }, o)),
        answerBox.length > 0 && h('button.btn.primary', { on: { click: () => submit() } }, 'Send')));
    return cardEl;
  }

  if (c.type === 'secret') {
    const user = h('input.input', { value: c.username || '', placeholder: 'Username or email', autocomplete: 'off' });
    const secret = h('input.input', { type: 'password', placeholder: c.kind === 'secret' ? 'Secret' : 'Password', autocomplete: 'new-password' });
    if (!pending) return h('div.approval-done', h('span', `${c.status === 'saved' ? 'Saved to Vault' : 'Not now'}: ${c.name}`));
    return h('div.card',
      h('div.card-h', c.title, statusPill('pending')),
      h('div.card-b', h('div.card-title', c.purpose), c.site && h('div.hint', c.site),
        c.kind !== 'secret' && user, secret, h('div.hint', 'Stored in your Mac Keychain. The Bot never sees it.')),
      h('div.card-actions',
        h('button.btn.primary', { on: { click: () => secret.value && cardAction(m, { username: user.value, secret: secret.value }) } }, 'Save'),
        h('button.btn.ghost', { on: { click: () => cardAction(m, { dismiss: true }) } }, 'Not now')));
  }

  if (c.type === 'connect') {
    if (c.status === 'connected' || c.status === 'dismissed') return h('div.approval-done', h('span', `${c.status === 'connected' ? 'Connected' : 'Not now'}: ${c.name}`));
    return h('div.card',
      h('div.card-h', logo({ name: c.name, color: c.color }, 20), `Connect ${c.name}`, statusPill(c.status)),
      h('div.card-b', h('div.card-title', `${b?.name || 'Your Bot'} needs ${c.name}.`), h('div', `Sign in once on ${b?.name || 'its'}${b ? "'s" : ''} computer. A window opens for you.`), c.note && h('div.warn', c.note)),
      h('div.card-actions',
        c.status === 'signing-in'
          ? [h('button.btn.primary', { on: { click: () => api('POST', '/api/computer/done', { botId: m.bot_id }) } }, "I'm done"), h('button.btn', { on: { click: () => api('POST', '/api/computer/focus', { botId: m.bot_id }) } }, 'Show window')]
          : [h('button.btn.primary', { on: { click: () => { cardAction(m, {}); } } }, c.note ? 'Reopen' : 'Authorize'),
            h('button.btn.ghost', { on: { click: () => cardAction(m, { dismiss: true }) } }, 'Not now')]));
  }

  if (c.type === 'takeover') {
    if (!pending) return h('div.approval-done', h('span', `You finished: ${c.reason}`));
    return computerCard({ botId: m.bot_id, state: comp(m.bot_id).control === 'user' ? 'control' : 'working', live: true, text: c.reason });
  }

  if (c.type === 'file') {
    if (c.kind === 'image' && !/^https?:/.test(c.ref)) return h('button.image-card', { on: { click: () => openViewer(c) } }, h('img', { src: fileUrl(c.ref), alt: c.title }));
    const ic = { page: 'page', image: 'image', link: 'link' }[c.kind] || 'file';
    const sub = /^https?:/.test(c.ref) ? new URL(c.ref).hostname.replace(/^www\./, '') : c.ref.split('/').pop();
    return h('button.file-card', { on: { click: () => openViewer(c) } }, h('span.ic', icon(ic)), h('span.t', h('b', c.title), h('small', sub)), h('span.btn', 'Open'));
  }

  if (c.type === 'skill_draft') {
    if (!pending) return h('div.approval-done', h('span', `${c.status === 'saved' ? 'Skill saved' : 'Discarded'}: ${c.name}`));
    const name = h('input.input', { value: c.name });
    const desc = h('input.input', { value: c.description });
    const body = h('textarea.textarea', { value: c.body, rows: 12, style: { fontFamily: 'var(--mono)', fontSize: '12px' } });
    return h('div.card.wide',
      h('div.card-h', c.title, statusPill('pending')),
      h('div.card-b', h('div.field', h('label', 'Name'), name), h('div.field', h('label', 'When to use it'), desc), body,
        h('div.hint', 'Drafted from one demonstration. Add what to do when something goes wrong, and which steps need your OK.')),
      h('div.card-actions',
        h('button.btn.primary', { on: { click: () => cardAction(m, { action: 'save', name: name.value, description: desc.value, body: body.value }) } }, 'Save skill'),
        h('button.btn.ghost', { on: { click: () => cardAction(m, { action: 'discard' }) } }, 'Discard')));
  }
  return null;
}

// ---------- Composer -----------------------------------------------------------------------------
let mentionState = null;
let recognizer = null;

function mentionCandidates(c, q) {
  const ql = q.toLowerCase();
  const out = [];
  const botsIn = c.kind === 'group' ? c.bot_ids.map(bot).filter(Boolean) : S.bots;
  if (c.kind === 'group' && 'everyone'.startsWith(ql)) out.push({ label: 'everyone', sub: 'Everyone here', insert: '@everyone ' });
  for (const b of botsIn) if (b.name.toLowerCase().startsWith(ql)) out.push({ label: b.name, sub: 'Bot', insert: `@${b.name} `, av: avatar(b, 20) });
  for (const a of S.connectors) if (a.name.toLowerCase().includes(ql)) out.push({ label: a.name, sub: 'App', insert: `@${a.name} `, av: logo(a, 20) });
  return out.slice(0, 10);
}

function renderComposer() {
  if (!$composer || !currentChatId) return;
  const c = chat(currentChatId);
  const isGroup = c?.kind === 'group';
  const ta = h('textarea', { rows: 1, placeholder: isGroup ? `Message ${c.name}` : `Message ${bot(c?.bot_ids[0])?.name || ''}` });
  const draftKey = `tandem.draft.${currentChatId}`;
  try { ta.value = localStorage.getItem(draftKey) || ''; } catch {}
  const pop = h('div.mention-pop', { hidden: true });
  const fileInput = h('input', { type: 'file', multiple: true, hidden: true, on: { change: (e) => addFiles(e.target.files) } });
  const action = h('button.round.dark');

  function autosize() { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 240) + 'px'; }
  function paintAction() {
    const hasText = ta.value.trim() || pendingFiles.length;
    action.className = `round ${recognizer ? 'rec' : 'dark'}`;
    action.title = hasText ? 'Send' : recognizer ? 'Stop dictation' : 'Dictate (⌘D)';
    action.replaceChildren(icon(hasText ? 'up' : 'mic'));
  }
  action.addEventListener('click', () => (ta.value.trim() || pendingFiles.length ? send() : dictate()));
  async function send() {
    const text = ta.value.trim();
    if (!text && !pendingFiles.length) return;
    const body = { text, parentId: replyTo?.id || null, attachments: pendingFiles };
    ta.value = ''; pendingFiles = []; replyTo = null;
    try { localStorage.removeItem(draftKey); } catch {}
    if (recognizer) recognizer.stop();
    renderComposer();
    try { await api('POST', `/api/chats/${currentChatId}/messages`, body); } catch (e) { toast(e.message, 'bad'); }
  }
  $composer._send = send;
  $composer._dictate = () => dictate();
  function updateMention() {
    const before = ta.value.slice(0, ta.selectionStart);
    const m = before.match(/(^|\s)@([\w.\- ]{0,24})$/);
    if (!m) { pop.hidden = true; mentionState = null; return; }
    const items = mentionCandidates(c, m[2]);
    if (!items.length) { pop.hidden = true; mentionState = null; return; }
    mentionState = { start: before.length - m[2].length - 1, items, sel: 0 };
    drawPop();
  }
  function drawPop() {
    pop.hidden = false;
    pop.replaceChildren(...mentionState.items.map((it, i) => h(`button${i === mentionState.sel ? '.sel' : ''}`, { on: { mousedown: (e) => { e.preventDefault(); pick(i); } } }, it.av || '@', it.label, h('small', it.sub))));
  }
  function pick(i) {
    const it = mentionState.items[i];
    const v = ta.value;
    ta.value = v.slice(0, mentionState.start) + it.insert + v.slice(ta.selectionStart);
    pop.hidden = true; mentionState = null; ta.focus(); paintAction();
  }
  ta.addEventListener('input', () => { autosize(); updateMention(); paintAction(); try { localStorage.setItem(draftKey, ta.value); } catch {} });
  ta.addEventListener('keydown', (e) => {
    if (mentionState && !pop.hidden) {
      if (e.key === 'ArrowDown') { e.preventDefault(); mentionState.sel = (mentionState.sel + 1) % mentionState.items.length; return drawPop(); }
      if (e.key === 'ArrowUp') { e.preventDefault(); mentionState.sel = (mentionState.sel - 1 + mentionState.items.length) % mentionState.items.length; return drawPop(); }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); return pick(mentionState.sel); }
      if (e.key === 'Escape') { pop.hidden = true; mentionState = null; return; }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
  });
  ta.addEventListener('paste', (e) => { const files = [...(e.clipboardData?.files || [])]; if (files.length) { e.preventDefault(); addFiles(files); } });

  async function addFiles(files) {
    for (const f of [...files].slice(0, 20)) {
      try {
        const r = await api('POST', '/api/uploads', f, { headers: { 'X-Filename': encodeURIComponent(f.name), 'Content-Type': f.type || 'application/octet-stream' } });
        pendingFiles.push({ name: r.name, path: r.path, type: r.type });
      } catch (e) { toast(`${f.name}: ${e.message}`, 'bad'); }
    }
    const keep = ta.value;
    renderComposer();
    const nta = $composer.querySelector('textarea');
    nta.value = keep; nta.focus();
  }
  function dictate() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return toast('Dictation isn’t supported in this browser', 'bad');
    if (recognizer) { recognizer.stop(); return; }
    recognizer = new SR();
    recognizer.continuous = true; recognizer.interimResults = true;
    const base = ta.value;
    recognizer.onresult = (e) => { ta.value = base + (base ? ' ' : '') + [...e.results].map((r) => r[0].transcript).join(''); autosize(); paintAction(); };
    recognizer.onend = () => { recognizer = null; paintAction(); };
    recognizer.start();
    paintAction();
  }
  const plus = h('button.round', { title: 'Add', on: { click: (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    menu(r.left, r.top - 130, [
      { label: 'Attach files', onClick: () => fileInput.click() },
      ...(!isGroup ? [{ label: 'Teach a task', onClick: () => teachTask(c.bot_ids[0], currentChatId) }] : []),
      { label: 'Mention a Bot or app', onClick: () => { ta.value += (ta.value && !ta.value.endsWith(' ') ? ' ' : '') + '@'; ta.focus(); updateMention(); } },
    ]);
  } } }, icon('plus'));

  $composer.ondragover = (e) => e.preventDefault();
  $composer.ondrop = (e) => { e.preventDefault(); addFiles(e.dataTransfer.files); };

  const top = (replyTo || pendingFiles.length) ? h('div.composer-top',
    replyTo && h('div.replying', `Replying to: ${(replyTo.text || replyTo.card?.summary || 'message').slice(0, 70)}`, h('button', { on: { click: () => { replyTo = null; renderComposer(); } } }, 'Cancel')),
    pendingFiles.map((f, i) => h('span.attach', icon('clip'), f.name, h('button.icon-btn', { style: { width: '18px', height: '18px' }, on: { click: () => { pendingFiles.splice(i, 1); renderComposer(); } } }, icon('x'))))) : null;

  $composer.replaceChildren(pop, h('div.composer-box', top, h('div.composer-row', plus, fileInput, ta, action)));
  autosize();
  paintAction();
  if (innerWidth > 820) setTimeout(() => ta.focus(), 0);
}

// ---------- Home ---------------------------------------------------------------------------------
function renderHome() {
  currentChatId = null;
  if (!S.bots.length) {
    $main.replaceChildren(h('div.empty', h('div',
      avatar({ shape: 'circle', color: '#6d5dfc' }, 76, { blink: true }),
      h('h2', 'Meet your first Bot'),
      h('p', 'Bots are AI coworkers. Give one a job, connect your apps, and message it like a teammate.'),
      h('div.hstack', { style: { justifyContent: 'center', marginTop: '18px' } },
        h('button.btn.primary', { on: { click: newBot } }, 'Create a Bot'),
        h('button.btn', { on: { click: () => go('#/templates') } }, 'Bot templates')))));
    return;
  }
  const first = flatOrder()[0];
  if (first && innerWidth > 820) return go(`#/chat/${first.id}`);
  $main.replaceChildren(h('div.empty', 'Choose a Bot'));
}

// ---------- Command palette & shortcuts --------------------------------------------------------
export function openPalette() {
  const input = h('input', { placeholder: 'Search messages, Bots, group chats, files and routines' });
  const res = h('div.palette-res');
  let items = [], sel = 0;
  const commands = [
    { label: 'Create a Bot', sub: '⌘N', run: newBot },
    { label: 'New group chat', sub: '⌘⇧N', run: () => newGroup() },
    { label: 'Connect apps', sub: '⌘⇧M', run: () => go('#/apps') },
    { label: 'Skills', run: () => go('#/skills') },
    { label: 'Bot templates', run: () => go('#/templates') },
    { label: 'Settings', sub: '⌘,', run: () => go('#/settings') },
    { label: 'Computer', run: () => toggleComputer() },
    { label: 'Keyboard shortcuts', sub: '⌘/', run: showShortcuts },
  ];
  const draw = (groups) => {
    items = [];
    res.replaceChildren(...groups.filter((g) => g.items.length).map((g) => [h('div.grp', g.name), g.items.map((it) => {
      const i = items.push(it) - 1;
      return h(`button${i === sel ? '.sel' : ''}`, { on: { click: () => { m.close(); it.run(); } } }, it.av || null, h('span', it.label), it.sub && h('small', it.sub));
    })]).flat());
  };
  const botItem = (b) => ({ label: b.name, sub: b.label, av: avatar(b, 22), run: () => go(`#/chat/${dmOf(b.id).id}`) });
  let t;
  const search = async () => {
    const q = input.value.trim();
    const cmd = commands.filter((c) => c.label.toLowerCase().includes(q.toLowerCase()));
    if (!q) return draw([{ name: 'Bots', items: S.bots.map(botItem) }, { name: 'Commands', items: cmd }]);
    const r = await api('GET', `/api/search?q=${encodeURIComponent(q)}`);
    draw([
      { name: 'Bots', items: r.bots.map(botItem) },
      { name: 'Group chats', items: r.groups.map((g) => ({ label: g.name, run: () => go(`#/chat/${g.id}`) })) },
      { name: 'Messages', items: r.messages.map((mm) => ({ label: mm.text.slice(0, 80), sub: `${chat(mm.chat_id)?.name || bot(mm.bot_id)?.name || ''} · ${shortTime(mm.created)}`, run: () => go(`#/chat/${mm.chat_id}`) })) },
      { name: 'Routines', items: r.routines.map((x) => ({ label: x.name, sub: bot(x.bot_id)?.name, run: () => openBotDrawer(x.bot_id, 'routines') })) },
      { name: 'Files', items: r.files.map((f) => ({ label: f.title, sub: f.kind, run: () => openViewer(f) })) },
      { name: 'Commands', items: cmd },
    ]);
  };
  input.addEventListener('input', () => { sel = 0; clearTimeout(t); t = setTimeout(search, 120); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(sel + 1, items.length - 1); search(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(sel - 1, 0); search(); }
    if (e.key === 'Enter' && items[sel]) { m.close(); items[sel].run(); }
  });
  const m = modal({ body: [input, res], cls: 'palette' });
  m.box.querySelector('.modal-b').style.padding = '0';
  search();
}

const SHORTCUTS = [
  ['Search', '⌘K'], ['Search Bots', '⌘⇧F'], ['New Bot', '⌘N'], ['New group chat', '⌘⇧N'], ['Keyboard shortcuts', '⌘/'],
  ['Compact sidebar', '⌘B'], ['Focus the message box', '⌘I'], ['Add selected text to chat', '⌘L'], ['Go to Bot 1 to 9', '⌘1 … ⌘9'],
  ['Previous or next Bot', '⌥↑ / ⌥↓'], ['Cycle Bots', '⌃Tab / ⌃⇧Tab'], ['Back or forward', '⌘[ / ⌘]'], ['Connect apps', '⌘⇧M'],
  ['Conversation details', '⌘⇧I'], ['Send', 'Enter or ⌘Enter'], ['New line', '⇧Enter'], ['Dictate', '⌘D'], ['Stop the Bot', '⌘.'], ['Settings', '⌘,'],
];
function showShortcuts() {
  modal({ title: 'Keyboard shortcuts', body: h('div.shortcuts', SHORTCUTS.map(([a, k]) => [h('span', a), h('kbd', k)]).flat()) });
}

// ---------- Routing -----------------------------------------------------------------------------
function render() {
  applyTheme();
  renderSidebar();
  const r = S.route;
  $app.classList.toggle('in-chat', r.name !== 'home');
  $app.classList.toggle('with-computer', S.showComputer);
  $app.classList.toggle('compact', compact);
  if (r.name === 'chat') {
    if (currentChatId !== r.id || !$messages?.isConnected) renderChat(r.id);
    else paintMessages({ keepScroll: true });
  } else {
    currentChatId = null;
    if (r.name === 'apps') renderApps($main, r);
    else if (r.name === 'skills') renderSkills($main, r);
    else if (r.name === 'settings') renderSettings($main, r);
    else if (r.name === 'templates') renderTemplates($main, r);
    else renderHome();
  }
  renderComputer();
}

on('state', render);
on('route', () => { replyTo = null; pendingFiles = []; render(); });
on('message', (m) => {
  const c = chat(m.chat_id);
  if (c && m.author !== 'system') {
    let text = m.text;
    if (!text && m.card) text = m.card.summary || m.card.title || m.card.question || m.card.reason || '';
    c.last = { author: m.author, bot_id: m.bot_id, text: String(text || '').replace(/[`*#>_]+/g, '').slice(0, 140), created: m.created };
  }
  if (m.chat_id === currentChatId) paintMessages({ keepScroll: true });
  renderSidebar();
});
on('run', (r) => {
  if (r.chatId === currentChatId) { if (r.ended) paintMessages({ keepScroll: true }); else paintWorking(); }
  renderSidebar();
});
on('computer-toggle', () => { $app.classList.toggle('with-computer', S.showComputer); renderComputer(); });
on('computer', () => { renderComputer(); renderTeachBar(); if (currentChatId) paintWorking(); });
on('notify', (n) => {
  const b = bot(n.botId);
  if (b && !b.notify) return;
  if (document.hasFocus() && n.chatId === currentChatId) return;
  if ('Notification' in window && Notification.permission === 'granted') {
    const note = new Notification(n.title || 'Tandem', { body: n.body, icon: '/icon.svg', tag: n.chatId });
    note.onclick = () => { window.focus(); go(`#/chat/${n.chatId}`); };
  } else toast(`${n.title}: ${n.body}`);
});

// Tick timers on working rows and the teach bar.
setInterval(() => {
  if (!currentChatId) return;
  document.querySelectorAll('.working .el').forEach((el, i) => { const r = runsIn(currentChatId)[i]; if (r) el.textContent = dur(Date.now() - r.started); });
  const tc = chat(currentChatId);
  const tt = tc?.kind === 'dm' ? comp(tc.bot_ids[0]).teach : null;
  if (tt && $teach && !$teach.hidden) { const tm = $teach.querySelector('time'); if (tm) tm.textContent = dur(Date.now() - tt.started); }
}, 1000);

// ---------- Keyboard shortcuts --------------------------------------------------------------------
function moveBot(delta) {
  const list = flatOrder();
  if (!list.length) return;
  const i = list.findIndex((c) => c.id === currentChatId);
  const next = list[(i + delta + list.length) % list.length];
  go(`#/chat/${next.id}`);
}
document.addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey;
  const k = e.key.toLowerCase();
  if (mod && !e.shiftKey && k === 'k') { e.preventDefault(); openPalette(); }
  else if (mod && e.shiftKey && k === 'f') { e.preventDefault(); if (compact) toggleCompact(); document.getElementById('sb-q')?.focus(); }
  else if (mod && e.shiftKey && k === 'n') { e.preventDefault(); newGroup(); }
  else if (mod && !e.shiftKey && k === 'n') { e.preventDefault(); newBot(); }
  else if (mod && (k === '/' || k === '?')) { e.preventDefault(); showShortcuts(); }
  else if (mod && !e.shiftKey && k === 'b') { e.preventDefault(); toggleCompact(); }
  else if (mod && !e.shiftKey && k === 'i') { e.preventDefault(); $composer?.querySelector('textarea')?.focus(); }
  else if (mod && !e.shiftKey && k === 'l') {
    e.preventDefault();
    const sel = String(getSelection() || '').trim();
    const ta = $composer?.querySelector('textarea');
    if (ta) { if (sel) { ta.value += (ta.value ? '\n' : '') + sel.split('\n').map((l) => `> ${l}`).join('\n') + '\n'; ta.dispatchEvent(new Event('input')); } ta.focus(); }
  }
  else if (mod && !e.shiftKey && /^[1-9]$/.test(e.key)) { const c = flatOrder()[Number(e.key) - 1]; if (c) { e.preventDefault(); go(`#/chat/${c.id}`); } }
  else if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { e.preventDefault(); moveBot(e.key === 'ArrowUp' ? -1 : 1); }
  else if (e.ctrlKey && e.key === 'Tab') { e.preventDefault(); moveBot(e.shiftKey ? -1 : 1); }
  else if (mod && e.key === '[') { e.preventDefault(); history.back(); }
  else if (mod && e.key === ']') { e.preventDefault(); history.forward(); }
  else if (mod && e.shiftKey && (k === 'm' || k === 'w')) { e.preventDefault(); go('#/apps'); }
  else if (mod && e.shiftKey && k === 'i') { e.preventDefault(); const c = chat(currentChatId); if (c?.kind === 'dm') openBotDrawer(c.bot_ids[0]); }
  else if (mod && e.altKey && k === 'b') { e.preventDefault(); const c = chat(currentChatId); if (c?.kind === 'dm') openBotDrawer(c.bot_ids[0]); }
  else if (mod && k === 'enter') { e.preventDefault(); $composer?._send?.(); }
  else if (mod && k === 'd' && document.activeElement?.closest('.composer')) { e.preventDefault(); $composer?._dictate?.(); }
  else if (mod && k === ',') { e.preventDefault(); go('#/settings'); }
  else if (mod && e.key === '.') { e.preventDefault(); if (currentChatId) api('POST', `/api/chats/${currentChatId}/stop`); }
});

// ---------- Boot ------------------------------------------------------------------------------------
window.addEventListener('hashchange', parseRoute);
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
if ('Notification' in window && Notification.permission === 'default') {
  document.addEventListener('click', () => Notification.requestPermission(), { once: true });
}
await refresh().catch((e) => toast(`Can't reach Tandem: ${e.message}`, 'bad'));
connectEvents();
parseRoute();
