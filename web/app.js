// Tandem web app: sidebar, conversations, cards, composer, palette, shortcuts.
import { api, h, md, avatar, groupAvatar, userAvatar, icon, toast, modal, confirm, menu, time, fileUrl, SHAPES, COLORS, logo, esc, loadLogos } from './lib.js';
import { S, on, refresh, bot, chat, dmOf, runsIn, squadRuns, squad, warmChat, isReady, go, parseRoute, toggleComputer, connectEvents, comp } from './store.js';
import { renderComputer } from './computer.js';
import { openBotDrawer } from './drawer.js';
import { renderApps, renderSkills, renderSettings, renderTemplates, renderActivity, planBars } from './pages.js';
import { needsOnboarding, renderOnboarding } from './onboarding.js';
import { startCall } from './voice.js';
import { renderHome as renderHomePage, refreshHome } from './home.js';
import { cheer } from './alive.js';
import { openQuickAsk } from './quickask.js';
import { renderMissions, newMission, missionCard, openMission, progress as missionProgress } from './missions.js';
import { renderInbox } from './inbox.js';
import { renderCompany } from './company.js';
import { renderOffice } from './office.js';

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

// Groups named after their members get a readable title: "Alice + 4".
export function groupTitle(c) {
  const members = c.bot_ids.map(bot).filter(Boolean);
  const auto = !c.name || c.name === members.map((b) => b.name).join(', ') || c.name.split(', ').length === members.length;
  if (!auto) return c.name;
  if (members.length <= 2) return members.map((b) => b.name).join(' & ');
  return `${members[0]?.name} + ${members.length - 1}`;
}

function chatRow(c) {
  const isGroup = c.kind === 'group';
  const b = isGroup ? null : bot(c.bot_ids[0]);
  if (!isGroup && !b) return null;
  const active = S.route.name === 'chat' && S.route.id === c.id;
  const run = runsIn(c.id)[0];
  const last = c.last;
  const unread = !active && last && last.author !== 'user' && last.created > getSeen(c.id);
  const name = isGroup ? groupTitle(c) : b.name;
  const room = isGroup && /^(#|Meeting: )/.test(c.name || '');
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
  room ? h('span.room-ic', c.name.startsWith('#') ? '#' : icon('users')) : isGroup ? groupAvatar(c.bot_ids.map(bot).filter(Boolean), 34) : avatar(b, 34, { blink: !!run }),
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
  const isRoom = (c) => /^(#|Meeting: )/.test(c.name || '');
  const rooms = S.chats.filter((c) => c.kind === 'group' && isRoom(c)).filter(match)
    .sort((a, b) => (a.name.startsWith('#') === b.name.startsWith('#') ? (a.name === '#general' ? -1 : b.name === '#general' ? 1 : a.name.localeCompare(b.name)) : a.name.startsWith('#') ? -1 : 1));
  const groups = S.chats.filter((c) => c.kind === 'group' && !isRoom(c)).filter(match);
  const sections = [...new Set(rest.map((c) => bot(c.bot_ids[0]).section).filter(Boolean))];
  const loose = [...rest.filter((c) => !bot(c.bot_ids[0]).section), ...groups].sort((a, b) => recency(b) - recency(a));
  return { primary, pinned, sections: sections.map((s) => [s, rest.filter((c) => bot(c.bot_ids[0]).section === s).sort((a, b) => recency(b) - recency(a))]), loose, hidden, rooms };
}
const flatOrder = () => { const o = sidebarOrder(); return [...o.rooms, ...o.primary, ...o.pinned, ...o.sections.flatMap(([, l]) => l), ...o.loose]; };

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
      h(`button.nav-row${S.route.name === 'home' ? '.active' : ''}`, { on: { click: () => go('#/home') } }, icon('home'), h('span', 'Home')),
      h(`button.nav-row${S.route.name === 'inbox' ? '.active' : ''}`, { on: { click: () => go('#/inbox') } }, icon('inbox'), h('span', 'Needs you'),
        S.pending.length ? h('span.badge', String(S.pending.length)) : null),
      h(`button.nav-row${S.route.name === 'company' ? '.active' : ''}`, { on: { click: () => go('#/company') } }, icon('users'), h('span', S.settings.company_name || 'Company'),
        S.runs.filter((r) => !r.squadId).length ? h('span.count-soft', `${S.runs.filter((r) => !r.squadId).length} working`) : null),
      h(`button.nav-row${S.route.name === 'office' ? '.active' : ''}`, { on: { click: () => go('#/office') } }, icon('monitor'), h('span', 'Office')),
      h(`button.nav-row${S.route.name === 'missions' ? '.active' : ''}`, { on: { click: () => go('#/missions') } }, icon('target'), h('span', 'Missions'),
        (S.missions || []).filter((m) => m.status === 'blocked').length ? h('span.badge', String(S.missions.filter((m) => m.status === 'blocked').length))
          : (S.missions || []).filter((m) => ['active', 'waiting'].includes(m.status)).length ? h('span.count-soft', String(S.missions.filter((m) => ['active', 'waiting'].includes(m.status)).length)) : null),
      h(`button.nav-row${S.route.name === 'activity' ? '.active' : ''}`, { on: { click: () => go('#/activity') } }, icon('activity'), h('span', 'Activity')),
      S.bots.length === 0 && h('div.hint', { style: { padding: '8px 10px' } }, 'No Bots yet.'),
      o.rooms.length > 0 && [h('div.sb-label', 'Channels'), o.rooms.map(chatRow)],
      o.primary.map(chatRow),
      o.pinned.length > 0 && [h('div.sb-label', 'Pinned'), o.pinned.map(chatRow)],
      o.sections.map(([name, list]) => [h('div.sb-label', name), list.map(chatRow)]),
      o.loose.length > 0 && [(o.primary.length || o.pinned.length || o.sections.length) ? h('div.sb-label', 'Bots') : null, o.loose.map(chatRow)],
      o.hidden.length > 0 && [h('div.sb-label', h('button', { style: { marginLeft: 0 }, on: { click: () => { showHidden = !showHidden; renderSidebar(); } } }, `${showHidden ? 'Hide' : 'Show'} hidden Bots (${o.hidden.length})`)),
        showHidden && o.hidden.map(chatRow)]),
    h('div.sb-foot',
      h(`button.foot-row${S.route.name === 'apps' ? '.me' : ''}`, { on: { click: () => go('#/apps') } }, icon('apps'), 'Connect apps'),
      h(`button.foot-row${S.route.name === 'skills' ? '.me' : ''}`, { on: { click: () => go('#/skills') } }, icon('book'), 'Skills'),
      (S.settings.plan?.week?.used >= 0.7 || S.settings.plan?.fiveHour?.used >= 0.8) && h('button.foot-row', { style: { display: 'block' }, title: 'Claude plan usage', on: { click: () => go('#/settings/usage') } }, planBars(S.settings.plan, { compact: true })),
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
  const sites = m.meta.sites?.length || 0, files = m.meta.files?.length || 0;
  const label = [`Worked for ${dur(m.meta.duration || 0)}`, tools && `${tools} step${tools === 1 ? '' : 's'}`,
    sites && `${sites} site${sites === 1 ? '' : 's'}`, files && `${files} file${files === 1 ? '' : 's'}`].filter(Boolean).join(' · ');
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
  if (k === 'mission') return h('button.sys.clickable', { on: { click: () => openMission(m.meta.missionId) } }, icon('target'), m.text);
  return h(`div.sys${m.meta?.error ? '.error' : ''}`, m.text);
}

function isLatestBot(m) {
  const list = S.messages[m.chat_id] || [];
  for (let i = list.length - 1; i >= 0; i--) { if (list[i].author === 'user') return false; if (list[i].id === m.id) return !runsIn(m.chat_id).length; }
  return false;
}
async function sendQuick(chatId, text) {
  optimisticRun(chatId);
  try { await api('POST', `/api/chats/${chatId}/messages`, { text }); } catch (e) { toast(e.message, 'bad'); }
}

function renderBotParts(m, isGroup, showWho) {
  const b = bot(m.bot_id);
  const parts = [];
  if (isGroup && showWho) parts.push(h('div.who', b?.name || 'Bot'));
  if (m.meta?.steps?.length > 0) parts.push(stepsBlock(m));
  if (m.meta?.browser && m.meta?.shot && m.text) parts.push(computerCard({ botId: m.bot_id, state: 'done', shot: fileUrl(m.meta.shot), text: null }));
  if (m.meta?.handoff && m.author === 'bot') parts.push(h('div.who', `From ${b?.name || 'a Bot'}`));
  if (m.text) {
    const full = m.meta?.full && openDetails.has(`full:${m.id}`);
    parts.push(h('div.bubble', { html: md(full ? m.meta.full : m.text) }));
    if (m.meta?.full) parts.push(h('button.more-link', { on: { click: () => { const k = `full:${m.id}`; openDetails.has(k) ? openDetails.delete(k) : openDetails.add(k); paintMessages({ keepScroll: true }); } } }, full ? 'Show less' : 'Show full answer'));
  }
  if (m.meta?.files?.length) parts.push(fileChips(m.meta.files));
  if (m.card) parts.push(renderCard(m));
  if (m.meta?.suggestions?.length && isLatestBot(m)) parts.push(h('div.suggest', m.meta.suggestions.map((t) => h('button.sug', { on: { click: () => sendQuick(m.chat_id, t) } }, t))));
  if (Object.keys(m.reactions || {}).length) parts.push(h('div.reactions', Object.keys(m.reactions).map((e) => h('button', { on: { click: () => api('POST', `/api/messages/${m.id}/react`, { emoji: e }) } }, e))));
  return parts;
}

const seenMsgs = new Set();
let animateNew = false;
function messageRow(m, prev, isGroup, { inThread = false } = {}) {
  const fresh = animateNew && !seenMsgs.has(m.id);
  seenMsgs.add(m.id);
  const el = messageRowInner(m, prev, isGroup, { inThread });
  if (fresh) [el].flat().filter(Boolean).forEach((x) => x.classList?.add('enter'));
  return el;
}
function messageRowInner(m, prev, isGroup, { inThread = false } = {}) {
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

// Live turns: one per running Bot. A trail of steps ticking from spinner to check (with
// timings), the live Computer card when it uses the browser, and the answer as it's written.
const openTrails = new Set();
function workingRows(chatId) {
  const runs = runsIn(chatId);
  const out = [];
  for (const r of runs) {
    const b = bot(r.botId);
    const trail = (r.trail || []).filter((x) => x.k === 'tool');
    const total = r.trailTotal || trail.length;
    const showAll = openTrails.has(r.id);
    const visible = showAll ? trail : trail.slice(-4);
    const hiddenCount = total - visible.length;
    const head = h('div.live-head', avatar(b, 24, { busy: true }),
      h('span.st.shimmer', r.optimistic ? 'Reading your message' : (r.status || 'Thinking')),
      h('span.el', dur(Date.now() - r.started)),
      h('button.btn.ghost.sm', { on: { click: () => api('POST', `/api/chats/${chatId}/stop`) } }, 'Stop'));
    const steps = visible.length ? h('ol.trail',
      hiddenCount > 0 && h('li.more', h('button', { on: { click: () => { openTrails.add(r.id); paintWorking(); } } }, `${hiddenCount} earlier step${hiddenCount === 1 ? '' : 's'}`)),
      visible.map((x) => h(`li.${x.s === 'ok' ? 'ok' : x.s === 'err' ? 'err' : 'run'}`,
        h('span.ic', x.s === 'ok' ? icon('check') : x.s === 'err' ? icon('x') : h('span.mini-spin')),
        h('span.lbl', x.t),
        x.ms != null ? h('span.ms', x.ms < 1000 ? `${x.ms}ms` : `${(x.ms / 1000).toFixed(1)}s`) : null))) : null;
    const turn = h('div.live-turn', head, steps);
    out.push(turn);
    if (r.browser) {
      const cs = comp(r.botId);
      const ctl = cs.control === 'user';
      out.push(h('div.row', h('div.col', computerCard({
        botId: r.botId, state: ctl ? 'control' : 'working', live: true,
        text: ctl ? (cs.takeover?.reason || 'You have control') : r.status,
      }))));
    }
    if (r.live && r.live.trim()) out.push(h('div.row', h('div.col', h('div.bubble.streaming', { html: md(r.live) + '<span class="caret"></span>' }))));
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

// A squad: helpers working on parts of one job at the same time, each on its own computer.
function squadCard(q) {
  if (!q) return h('div.approval-done', h('span', 'Squad'));
  const runs = squadRuns(q.id);
  const done = q.parts.filter((p) => p.status === 'done').length;
  const live = q.status === 'working';
  const working = q.parts.filter((p) => p.status === 'working').length;
  const sub = live ? `${working} working at once · ${done} of ${q.parts.length} done`
    : q.status === 'merging' ? `All ${q.parts.length} parts back · ${bot(q.leadId)?.name || 'The lead'} is checking and merging`
    : q.status === 'done' ? (() => {
      const work = q.parts.reduce((n, p) => n + (p.ended && p.started ? p.ended - p.started : 0), 0), wall = (q.finished || Date.now()) - q.created;
      return h('span', `${q.parts.length} parts done in parallel · `, h('b.sq-win', `${dur(work)} of work in ${dur(wall)}`));
    })() : 'Stopped';
  const tiles = q.parts.map((p) => {
    const r = runs.find((x) => x.botId === p.botId);
    const hb = bot(p.botId);
    let screen;
    if (p.status === 'working') {
      const img = h('img', { alt: '', src: liveShots[p.botId] || '', hidden: !liveShots[p.botId] });
      img.dataset.live = p.botId;
      screen = h('div.sq-screen', img, !liveShots[p.botId] && h('div.empty', 'Starting its computer'));
    } else {
      const ic = { done: 'check', failed: 'x', stopped: 'x' }[p.status];
      screen = h(`div.sq-screen.idle.${p.status}${p.ended && Date.now() - p.ended < 2500 ? '.just' : ''}${p.shot ? '.has-shot' : ''}`,
        p.shot && h('img', { src: fileUrl(p.shot), alt: '' }), ic ? h('span.sq-badge', icon(ic)) : h('span', 'Waiting for a free helper'));
    }
    const line = p.status === 'working' ? (r?.status || 'Working')
      : p.status === 'done' ? `Done in ${dur(p.ended - p.started)}` : p.status === 'failed' ? 'Ran into a problem' : p.status === 'stopped' ? 'Stopped' : 'Queued';
    const open = p.status === 'done' && p.file ? () => window.open(fileUrl(p.file), '_blank') : null;
    return h(`div.sq-tile.is-${p.status}`, { title: p.report || '', ...(open ? { on: { click: open }, role: 'button' } : {}) },
      screen,
      h('div.sq-meta', hb ? avatar(hb, 18, { busy: p.status === 'working' }) : null,
        h('div.sq-t', h('b', p.title), h('span', p.status === 'working' && p.started ? [line, h('i', { 'data-since': p.started }, ` · ${dur(Date.now() - p.started)}`)] : open ? `${line} · Open` : line))));
  });
  return h(`div.card.squad-card${live ? '.sq-live' : ''}`, { 'data-squad': q.id },
    h('div.card-h', 'Squad', h(`span.pill${live || q.status === 'merging' ? '.warn.spin' : q.status === 'done' ? '.good' : ''}`, live ? 'Working' : q.status === 'merging' ? 'Merging' : q.status === 'done' ? 'Done' : 'Stopped')),
    h('div.card-b', h('div.card-title', q.goal), h('div.sq-sub', sub, live && h('i', { 'data-since': q.created }, ` · ${dur(Date.now() - q.created)}`))),
    h('div.sq-bar', h('i', { style: { width: `${Math.round((done / q.parts.length) * 100)}%` } })),
    h('div.sq-grid', { style: { gridTemplateColumns: `repeat(${q.parts.length <= 4 ? q.parts.length : q.parts.length <= 6 ? 3 : 4}, minmax(0, 1fr))` } }, tiles),
    live ? h('div.card-actions', h('button.btn.ghost', { on: { click: async () => { if (await confirm('Stop the squad? Parts already finished are kept.', { danger: true, label: 'Stop squad' })) api('POST', `/api/squads/${q.id}/stop`); } } }, 'Stop squad'))
      : h('div', { style: { height: '12px' } }));
}
function repaintSquad(id) {
  const q = squad(id);
  document.querySelectorAll(`.squad-card[data-squad="${id}"]`).forEach((el) => el.replaceWith(squadCard(q)));
}
on('squad', (q) => repaintSquad(q.id));
let readyPainter = null;
on('ready', () => readyPainter?.());
on('run', (r) => { if (r.squadId) repaintSquad(r.squadId); });
// Running clocks on squad cards.
setInterval(() => document.querySelectorAll('[data-since]').forEach((el) => { el.textContent = ` · ${dur(Date.now() - Number(el.dataset.since))}`; }), 1000);

// The moment you hit send, the Bot visibly picks it up (replaced by the real run).
export function optimisticRun(chatId) {
  const c = chat(chatId);
  if (!c || c.kind !== 'dm' || runsIn(chatId).length) return;
  const fake = { id: `opt_${Date.now()}`, botId: c.bot_ids[0], chatId, started: Date.now(), status: 'Reading your message', optimistic: true, trail: [] };
  S.runs.push(fake);
  paintWorking();
  setTimeout(() => { const i = S.runs.indexOf(fake); if (i >= 0) { S.runs.splice(i, 1); paintWorking(); renderSidebar(); } }, 12000);
  renderSidebar();
}

// Poll each live computer card's screen while its Bot is working here.
const liveShots = {};
setInterval(async () => {
  if (document.hidden) return;
  const ids = [...new Set([...document.querySelectorAll('img[data-live]')].map((i) => i.dataset.live))];
  await Promise.all(ids.map(async (id) => {
    try {
      const r = await fetch(`/api/computer/screenshot?bot=${encodeURIComponent(id)}`, { cache: 'no-store' });
      if (!r.ok) return;
      const url = URL.createObjectURL(await r.blob());
      const old = liveShots[id];
      liveShots[id] = url;
      document.querySelectorAll(`img[data-live="${id}"]`).forEach((i) => { i.src = url; i.hidden = false; i.parentElement.querySelector('.empty')?.remove(); });
      if (old) setTimeout(() => URL.revokeObjectURL(old), 2000);
    } catch {}
  }));
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
    h('h2', groupTitle(c)), h('p', 'Write normally and the Bots decide who responds, or @mention one to give it ownership.')));
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
      isGroup ? groupAvatar(members, 24) : avatar(b, 24), h('span', isGroup ? groupTitle(c) : b?.name),
      isGroup ? h('span.hint', { style: { fontWeight: 400, marginLeft: '2px' } }, `${members.length} Bots`) : null),
    !isGroup && missionPill(b.id),
    h('div.spacer'),
    !isGroup && h('button.icon-btn', { title: 'Start voice chat', on: { click: () => startCall(chatId) } }, icon('phone')),
    h('button.icon-btn', { title: 'Computer', on: { click: () => toggleComputer() } }, icon('monitor')),
    h('button.icon-btn', { title: 'More', on: { click: (e) => menu(e.clientX - 180, e.clientY + 12, [
      ...(!isGroup ? [{ label: 'View conversation details', onClick: () => openBotDrawer(b.id) }, { label: 'Routines', onClick: () => openBotDrawer(b.id, 'routines') }, { label: 'Library', onClick: () => openBotDrawer(b.id, 'library') }, { label: 'Teach a task', onClick: () => teachTask(b.id, chatId) }] : []),
      { label: 'Reset conversation', onClick: async () => { if (await confirm('Reset this conversation? Memory, files, routines and settings are kept.', { danger: false, label: 'Reset' })) api('POST', `/api/chats/${chatId}/reset`); } },
      ...(isGroup ? [{ label: 'Edit members', onClick: () => newGroup(c) }, { label: 'Delete group', danger: true, onClick: async () => { if (await confirm(`Delete "${c.name}"?`)) { await api('DELETE', `/api/chats/${c.id}`); go('#/'); } } }] : []),
    ]) } }, icon('more')));

  $messages = h('div.messages', { on: { scroll: () => $main.classList.toggle('scrolled', $messages.scrollTop > 4) } });
  $teach = h('div.teach-bar', { hidden: true });
  $composer = h('div.composer');
  $main.replaceChildren(head, $messages, $teach, $composer);
  renderComposer();
  renderTeachBar();
  if (S.messages[chatId]) paintMessages();
  else $messages.replaceChildren(h('div.msg-wrap', h('div.skel', h('div'), h('div'), h('div'))));
  animateNew = false;
  loadMessages(chatId).then(() => { if (currentChatId === chatId) { paintMessages(); animateNew = true; } });
}

function missionPill(botId) {
  const m = (S.missions || []).find((x) => x.bot_id === botId && ['active', 'waiting', 'blocked', 'paused'].includes(x.status));
  if (!m) return null;
  const p = missionProgress(m.plan);
  return h(`button.mission-pill${m.status === 'blocked' ? '.bad' : ''}`, { title: 'Open mission', on: { click: () => openMission(m.id) } },
    icon('target'), h('span', m.title), p.total ? h('b', `${p.done}/${p.total}`) : null);
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
// Gmail for the whole team: one app password, every Bot uses it, nothing to sign in again.
export function gmailConnectCard(submit) {
  const addr = h('input.input', { type: 'email', placeholder: 'you@gmail.com', autocomplete: 'off', value: S.settings.user_email || '' });
  const pass = h('input.input', { type: 'password', placeholder: '16-letter app password', autocomplete: 'new-password' });
  const err = h('div.hint', { style: { color: 'var(--bad)' } });
  const go = async () => {
    err.textContent = '';
    try { await submit({ address: addr.value.trim(), appPassword: pass.value }); }
    catch (e) { err.textContent = e.message; }
  };
  return h('div.card.wide', h('div.card-h', 'Connect Gmail', h('span.pill.warn', 'Once for everyone')),
    h('div.card-b',
      h('div.card-title', 'Every Bot gets your Gmail. No browser sign-ins, nothing to log in to again.'),
      h('ol.steps-ol',
        h('li', 'Open ', h('a', { href: 'https://myaccount.google.com/apppasswords', target: '_blank', rel: 'noopener' }, 'Google app passwords'), ' and sign in if asked.'),
        h('li', 'Name it "Tandem" and press Create.'),
        h('li', 'Paste the 16 letters below.')),
      h('div.draft-field', h('label', 'Gmail'), addr), h('div.draft-field', h('label', 'App password'), pass), err,
      h('div.hint', 'It stays in your Mac\'s Keychain. Bots never see it. Revoke it any time from the same Google page.')),
    h('div.card-actions', h('button.btn.primary', { on: { click: go } }, 'Connect Gmail')));
}

// What a Bot made this turn, as chips you can open right here.
const FILE_ICON = { image: 'image', sheet: 'table', doc: 'file', slides: 'slides', page: 'page', code: 'code', file: 'file' };
const size = (n) => n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`;
function fileChips(files) {
  return h('div.deliverables', files.map((f) => h(`button.deliv.k-${f.kind}`, { title: f.path, on: { click: () => openViewer({ title: f.name, ref: f.path }) } },
    f.kind === 'image' ? h('span.deliv-thumb', h('img', { src: fileUrl(f.path), alt: '', loading: 'lazy' })) : h('span.deliv-ic', icon(FILE_ICON[f.kind] || 'file')),
    h('span.deliv-t', h('b', f.name), h('span', [f.kind === 'sheet' ? 'Spreadsheet' : f.kind === 'image' ? 'Image' : f.kind === 'doc' ? 'Document' : f.kind === 'slides' ? 'Slides' : f.kind === 'page' ? 'Web page' : f.kind === 'code' ? 'Code' : 'File', size(f.size || 0)].join(' · '))))));
}

// CSV with quoted fields.
function parseCsv(text, sep = ',') {
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === sep) { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; }
    else cur += ch;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows.filter((r) => r.some((c) => c !== ''));
}

// A preview panel that slides in from the right: Markdown, tables, JSON, code, images, PDFs and pages.
let $viewer = null;
export function openViewer({ title, ref, kind }) {
  const isUrl = /^https?:/.test(ref);
  if (isUrl) return window.open(ref, '_blank', 'noopener');
  $viewer?.remove();
  const url = fileUrl(ref);
  const name = title || ref.split('/').pop();
  const ext = (ref.match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();
  let body, text = null;
  const meta = h('span.viewer-meta');
  if (kind === 'image' || /^(png|jpe?g|gif|webp|svg)$/.test(ext)) body = h('div.img-wrap', h('img', { src: url, alt: name }));
  else if (/^(md|markdown|txt|log|csv|tsv|json|js|ts|py|sh|css|yml|yaml|xml)$/.test(ext)) {
    body = h('div.v-scroll', h('div.v-loading', 'Opening…'));
    fetch(url).then((r) => r.text()).then((t) => {
      text = t;
      let inner;
      if (ext === 'md' || ext === 'markdown') inner = h('div.md.v-doc', { html: md(t) });
      else if (ext === 'csv' || ext === 'tsv') {
        const rows = parseCsv(t, ext === 'tsv' ? '\t' : ',');
        const [head = [], ...rest] = rows;
        meta.textContent = `${rest.length.toLocaleString()} row${rest.length === 1 ? '' : 's'} · ${head.length} column${head.length === 1 ? '' : 's'}`;
        const num = (v) => /^\s*[-$€£]?\s?[\d,]+(\.\d+)?\s*%?\s*$/.test(v);
        inner = h('div.v-table', h('table', h('thead', h('tr', h('th.rn', ''), head.map((c) => h('th', c)))),
          h('tbody', rest.slice(0, 2000).map((r, i) => h('tr', h('td.rn', String(i + 1)), head.map((_, j) => h(`td${num(r[j] || '') ? '.num' : ''}`, r[j] ?? '')))))));
      } else if (ext === 'json') { let pretty = t; try { pretty = JSON.stringify(JSON.parse(t), null, 2); } catch {} inner = h('pre.v-code', pretty); }
      else inner = h('pre.v-code', t);
      body.replaceChildren(inner);
    }).catch(() => body.replaceChildren(h('div.v-loading', 'Couldn’t open this file.')));
  } else if (/^(pdf|html?)$/.test(ext)) body = h('iframe', { src: url, title: name });
  else body = h('div.v-none', h('span.deliv-ic.big', icon(/^(xlsx?|numbers)$/.test(ext) ? 'table' : /^(pptx?|key)$/.test(ext) ? 'slides' : 'file')),
    h('b', name), h('p', 'Preview isn’t available for this kind of file.'), h('a.btn.primary', { href: fileUrl(ref, true) }, icon('download'), 'Download'));
  const close = () => { $viewer?.classList.add('out'); const v = $viewer; $viewer = null; setTimeout(() => v?.remove(), 180); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape' && !document.querySelector('.modal-bg')) close(); };
  $viewer = h('div.viewer.panel',
    h('div.viewer-h', h('span.deliv-ic', icon(/^(csv|tsv|xlsx?)$/.test(ext) ? 'table' : /^(png|jpe?g|gif|webp|svg)$/.test(ext) ? 'image' : /^(json|js|ts|py|sh|css)$/.test(ext) ? 'code' : 'file')),
      h('div.viewer-title', h('span.t', name), meta),
      h('button.icon-btn', { title: 'Copy contents', on: { click: async () => { if (text == null) return; await navigator.clipboard.writeText(text); toast('Copied'); } } }, icon('copy')),
      h('a.icon-btn', { title: 'Open in a new tab', href: url, target: '_blank' }, icon('open')),
      h('a.icon-btn', { title: 'Download', href: fileUrl(ref, true) }, icon('download')),
      h('button.icon-btn', { title: 'Close (Esc)', on: { click: close } }, icon('x'))),
    body);
  document.body.append($viewer);
  document.addEventListener('keydown', onKey);
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
      const label = c.status === 'review' ? h('span.pill', `With ${c.reviewer || 'its boss'} for review`) : c.status === 'returned' ? h('span.pill.bad', `Sent back by ${c.reviewedBy || 'its boss'}`) : statusPill(c.status);
      return h('div.card', h('div.card-h', `${c.app || 'Email'} draft`, label),
        h('div.card-b', h('div.card-title', c.subject || c.to), h('div', { style: { whiteSpace: 'pre-wrap' } }, (c.body || '').slice(0, 280) + ((c.body || '').length > 280 ? '…' : '')),
          c.status === 'returned' && c.reviewNote && h('div.review-note', h('b', `${c.reviewedBy}: `), c.reviewNote)));
    }
    return h('div.card.wide',
      h('div.card-h', `${c.app || 'Email'} draft`, c.reviewedBy ? h('span.pill.good', `Reviewed by ${c.reviewedBy}`) : h('span.pill.warn', 'Needs approval')),
      (c.reviewedBy && c.reviewNote) || (c.reviewNote && !c.reviewedBy) ? h('div.review-note', h('b', c.reviewedBy ? `${c.reviewedBy}: ` : ''), c.reviewNote) : null,
      h('div.card-b', field('to', 'To'), (c.cc) && field('cc', 'Cc'), !isChat && field('subject', 'Subject'), inputs.body,
        c.thread && h('div.hint', `In reply to: ${c.thread}`)),
      h('div.card-actions',
        h('button.btn.primary', { on: { click: () => cardAction(m, { action: 'send', edits: edits() }) } }, isChat ? 'Send message' : 'Send'),
        h('button.btn', { on: { click: () => cardAction(m, { action: 'discard' }) } }, 'Discard'),
        h('button.btn.ghost', { style: { marginLeft: 'auto' }, on: { click: () => api('PATCH', `/api/bots/${m.bot_id}`, { drafts: 0 }).then(() => toast(`${b?.name} will send directly from now on`)) } }, 'Turn off drafts')));
  }

  if (c.type === 'gmail_connect') {
    if (!pending) return h('div.approval-done', h('span', c.status === 'connected' ? `Gmail connected for the whole team${c.email ? `: ${c.email}` : ''}` : 'Gmail not connected'));
    return gmailConnectCard((payload) => cardAction(m, payload));
  }

  if (c.type === 'hire') {
    const boss = bot(c.boss);
    if (!pending) return h('div.approval-done', h('span', c.status === 'hired' ? `You hired a ${c.role}${c.hired && bot(c.hired) ? `: ${bot(c.hired).name}` : ''}` : `You declined hiring a ${c.role}`));
    const nameIn = h('input.input', { value: c.name || '', placeholder: c.role });
    return h('div.card.wide', h('div.card-h', 'Hiring request', h('span.pill.warn', 'Needs you')),
      h('div.card-b', h('div.card-title', `${boss?.name || 'A Bot'} wants to hire a ${c.role}`), h('div.md', { html: md(c.why || '') }),
        h('div.draft-field', h('label', 'Name'), nameIn), h('div.hint', `They'd report to ${boss?.name || 'its boss'} and get their own ${S.settings.computer_mode === 'laptop' ? 'laptop' : 'computer'}.`)),
      h('div.card-actions', h('button.btn.primary', { on: { click: () => cardAction(m, { name: nameIn.value.trim() }) } }, 'Hire'), h('button.btn', { on: { click: () => cardAction(m, { decline: true }) } }, 'Not now')));
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

  if (c.type === 'squad') return squadCard(squad(c.squadId) || c.squad);

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

// Slash commands in the message box.
const SLASH = [
  { name: 'mission', hint: 'Hand off something big, for hours or days', arg: 'the goal', wrap: (a) => `Take this on as a mission and own it until it's done. Confirm the done criteria in one line, then start: ${a}` },
  { name: 'routine', hint: 'Do something on a schedule', arg: 'what and when', wrap: (a) => `Set up a routine: ${a}` },
  { name: 'remember', hint: 'Save a fact or rule', arg: 'what to remember', wrap: (a) => `Remember this: ${a}` },
  { name: 'draft', hint: 'Draft something for your review', arg: 'what to draft', wrap: (a) => `Draft this for my review, and don't send it: ${a}` },
  { name: 'research', hint: 'Research with sources', arg: 'the question', wrap: (a) => `Research this thoroughly, cite your sources, and give me a short summary: ${a}` },
  { name: 'skill', hint: 'Use a saved skill', arg: 'skill name', wrap: (a) => `Use your skill "${a}" now.` },
  { name: 'handoff', hint: 'Ask another Bot to do it', arg: 'Bot name and task', wrap: (a) => `Hand this to another Bot with message_bot and tell me when it's done: ${a}` },
  { name: 'teach', hint: 'Show it how to do a task', run: (c) => teachTask(c.bot_ids[0], c.id) },
  { name: 'voice', hint: 'Start a voice chat', run: (c) => startCall(c.id) },
  { name: 'computer', hint: 'Show its computer', run: () => toggleComputer(true) },
  { name: 'stop', hint: 'Stop what it is doing', run: (c) => api('POST', `/api/chats/${c.id}/stop`) },
  { name: 'reset', hint: 'Start a fresh conversation', run: async (c) => { if (await confirm('Reset this conversation? Memory, files, routines and settings are kept.', { danger: false, label: 'Reset' })) api('POST', `/api/chats/${c.id}/reset`); } },
];

function renderComposer() {
  if (!$composer || !currentChatId) return;
  const c = chat(currentChatId);
  const isGroup = c?.kind === 'group';
  const ta = h('textarea', { rows: 1, placeholder: isGroup ? 'Message the group, @mention a Bot to give it the task' : `Message ${bot(c?.bot_ids[0])?.name || ''}, or type / for commands` });
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
    let text = ta.value.trim();
    if (!text && !pendingFiles.length) return;
    const sm = text.match(/^\/(\w+)\s*([\s\S]*)$/);
    const cmd = sm && SLASH.find((x) => x.name === sm[1].toLowerCase());
    if (cmd?.run) { ta.value = ''; paintAction(); return cmd.run(c); }
    if (cmd?.wrap) { if (!sm[2].trim()) return toast(`Add ${cmd.arg} after /${cmd.name}`, 'bad'); text = cmd.wrap(sm[2].trim()); }
    const body = { text, parentId: replyTo?.id || null, attachments: pendingFiles };
    ta.value = ''; pendingFiles = []; replyTo = null;
    try { localStorage.removeItem(draftKey); } catch {}
    if (recognizer) recognizer.stop();
    renderComposer();
    optimisticRun(currentChatId);
    try { await api('POST', `/api/chats/${currentChatId}/messages`, body); } catch (e) { toast(e.message, 'bad'); }
  }
  $composer._send = send;
  $composer._dictate = () => dictate();
  function updateMention() {
    const sm = ta.value.match(/^\/(\w*)$/);
    if (sm) {
      const items = SLASH.filter((x) => x.name.startsWith(sm[1].toLowerCase()) && (!x.run || !isGroup || x.name === 'stop' || x.name === 'reset' || x.name === 'computer'))
        .map((x) => ({ label: `/${x.name}`, sub: x.hint, slash: x }));
      if (!items.length) { pop.hidden = true; mentionState = null; return; }
      mentionState = { start: 0, items, sel: 0, slash: true };
      return drawPop();
    }
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
    pop.replaceChildren(...mentionState.items.map((it, i) => it.slash
      ? h(`button.cmd${i === mentionState.sel ? '.sel' : ''}`, { on: { mousedown: (e) => { e.preventDefault(); pick(i); } } }, h('b', it.label), h('small', it.slash.arg ? `${it.sub} · ${it.slash.arg}` : it.sub))
      : h(`button${i === mentionState.sel ? '.sel' : ''}`, { on: { mousedown: (e) => { e.preventDefault(); pick(i); } } }, it.av || '@', it.label, h('small', it.sub))));
  }
  function pick(i) {
    const it = mentionState.items[i];
    if (it.slash) {
      pop.hidden = true; mentionState = null;
      if (it.slash.run) { ta.value = ''; try { localStorage.removeItem(draftKey); } catch {} paintAction(); return it.slash.run(c); }
      ta.value = `/${it.slash.name} `; ta.focus(); paintAction(); return;
    }
    const v = ta.value;
    ta.value = v.slice(0, mentionState.start) + it.insert + v.slice(ta.selectionStart);
    pop.hidden = true; mentionState = null; ta.focus(); paintAction();
  }
  ta.addEventListener('input', () => { autosize(); updateMention(); paintAction(); if (c) warmChat(c.id, ta.value); try { localStorage.setItem(draftKey, ta.value); } catch {} });
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
      ...(!isGroup ? [{ label: 'Start a mission', onClick: () => newMission(c.bot_ids[0]) }] : []),
      ...(!isGroup ? [{ label: 'Start voice chat', onClick: () => startCall(currentChatId) }, { label: 'Teach a task', onClick: () => teachTask(c.bot_ids[0], currentChatId) }] : []),
      { label: 'Mention a Bot or app', onClick: () => { ta.value += (ta.value && !ta.value.endsWith(' ') ? ' ' : '') + '@'; ta.focus(); updateMention(); } },
    ]);
  } } }, icon('plus'));

  $composer.ondragover = (e) => e.preventDefault();
  $composer.ondrop = (e) => { e.preventDefault(); addFiles(e.dataTransfer.files); };

  const top = (replyTo || pendingFiles.length) ? h('div.composer-top',
    replyTo && h('div.replying', `Replying to: ${(replyTo.text || replyTo.card?.summary || 'message').slice(0, 70)}`, h('button', { on: { click: () => { replyTo = null; renderComposer(); } } }, 'Cancel')),
    pendingFiles.map((f, i) => h('span.attach', icon('clip'), f.name, h('button.icon-btn', { style: { width: '18px', height: '18px' }, on: { click: () => { pendingFiles.splice(i, 1); renderComposer(); } } }, icon('x'))))) : null;

  // Shown once the Bot's session is warm: your message starts the instant you send it.
  const ready = h('span.ready-chip', { title: 'Ready: work starts the moment you send' }, icon('bolt'), 'Ready');
  const paintReady = () => ready.classList.toggle('on', !!c && isReady(c.id) && !!ta.value.trim());
  ta.addEventListener('input', paintReady);
  readyPainter = paintReady;
  $composer.replaceChildren(pop, h('div.composer-box', top, h('div.composer-row', plus, fileInput, ta, ready, action)));
  autosize();
  paintAction();
  if (innerWidth > 820) setTimeout(() => ta.focus(), 0);
}

// ---------- Home ---------------------------------------------------------------------------------
const homeDeps = () => ({ renderCard, planBars, missionCard, newMission });
function renderHome() {
  currentChatId = null;
  if (needsOnboarding()) return renderOnboarding($main);
  if (S.bots.length) return renderHomePage($main, homeDeps());
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
}

// ---------- Command palette & shortcuts --------------------------------------------------------
export function openPalette() {
  const input = h('input', { placeholder: 'Search messages, Bots, group chats, files and routines' });
  const res = h('div.palette-res');
  let items = [], sel = 0;
  const commands = [
    { label: 'Quick Ask', sub: '⌘J', run: () => openQuickAsk({ onSent: optimisticRun }) },
    { label: 'Create a Bot', sub: '⌘N', run: newBot },
    { label: 'New group chat', sub: '⌘⇧N', run: () => newGroup() },
    { label: 'Connect apps', sub: '⌘⇧M', run: () => go('#/apps') },
    { label: 'Home', run: () => go('#/home') },
    { label: 'Needs you', run: () => go('#/inbox') },
    { label: 'Company', run: () => go('#/company') },
    { label: 'Office floor', run: () => go('#/office') },
    { label: 'Missions', run: () => go('#/missions') },
    { label: 'Start a mission', run: () => newMission() },
    { label: 'Skills', run: () => go('#/skills') },
    { label: 'Activity', run: () => go('#/activity') },
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
  ['Quick Ask (any Bot, anywhere)', '⌘J  ·  ⌥Space on your Mac'], ['Search', '⌘K'], ['Search Bots', '⌘⇧F'], ['New Bot', '⌘N'], ['New group chat', '⌘⇧N'], ['Keyboard shortcuts', '⌘/'],
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
  $app.classList.toggle('in-chat', !(r.name === 'home' && innerWidth <= 820));
  $app.classList.toggle('with-computer', S.showComputer);
  $app.classList.toggle('compact', compact);
  if (needsOnboarding() && r.name !== 'settings') { currentChatId = null; $app.classList.add('in-chat'); renderOnboarding($main); renderComputer(); return; }
  if (r.name === 'chat') {
    if (currentChatId !== r.id || !$messages?.isConnected) renderChat(r.id);
    else paintMessages({ keepScroll: true });
  } else {
    currentChatId = null;
    if (r.name === 'apps') renderApps($main, r);
    else if (r.name === 'skills') renderSkills($main, r);
    else if (r.name === 'settings') renderSettings($main, r);
    else if (r.name === 'templates') renderTemplates($main, r);
    else if (r.name === 'activity') renderActivity($main, r);
    else if (r.name === 'missions') renderMissions($main);
    else if (r.name === 'company') renderCompany($main);
    else if (r.name === 'office') renderOffice($main);
    else if (r.name === 'inbox') renderInbox($main, { renderCard });
    else renderHome();
  }
  renderComputer();
}

on('state', () => { render(); nativeStatus(); });
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
  if (r.ended) setTimeout(() => cheer(r.botId), 60);
  renderSidebar();
  homeSoon(!!r.ended);
  nativeStatus();
});
let homeTimer;
let homeRefetch = false;
function homeSoon(refetch = false) { homeRefetch ||= refetch; clearTimeout(homeTimer); homeTimer = setTimeout(() => { refreshHome(homeDeps(), { refetch: homeRefetch }); homeRefetch = false; }, 250); }
on('message', () => { homeSoon(); nativeStatus(); });

// ---------- Mac app bridge ---------------------------------------------------------------------
const nativePost = (msg) => { try { window.webkit?.messageHandlers?.tandem?.postMessage(msg); } catch {} };
function nativeStatus() {
  if (!S.native) return;
  nativePost({ type: 'status', pending: S.pending.length,
    working: S.runs.map((r) => ({ name: bot(r.botId)?.name || 'Bot', status: r.status || 'Working', chatId: r.chatId })) });
}
if (S.native) {
  document.documentElement.classList.add('native');
  // Empty parts of the top bars drag the window; double-click zooms, like a title bar.
  document.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    const bar = e.target.closest('.sb-top, .chat-head, .page-top, .home-top, .cp-head');
    if (bar && !e.target.closest('button, input, textarea, select, a, [contenteditable]')) nativePost({ type: e.detail === 2 ? 'zoom' : 'drag' });
  });
}
window.tandemNewBot = () => newBot();
let actTimer;
on('activity', () => { if (S.route.name !== 'activity') return; clearTimeout(actTimer); actTimer = setTimeout(() => renderActivity($main), 800); });
on('usage', () => renderSidebar());
on('mission', () => {
  renderSidebar();
  homeSoon();
  if (currentChatId && S.route.name === 'chat') {
    const head = $main.querySelector('.chat-head');
    const c = chat(currentChatId);
    if (head && c?.kind === 'dm') { head.querySelector('.mission-pill')?.remove(); const pill = missionPill(c.bot_ids[0]); if (pill) head.querySelector('.title').after(pill); }
  }
});
on('computer-toggle', () => { $app.classList.toggle('with-computer', S.showComputer); renderComputer(); });
on('computer', () => { renderComputer(); renderTeachBar(); if (currentChatId) paintWorking(); });
on('notify', (n) => {
  const b = bot(n.botId);
  if (b && !b.notify) return;
  if (S.native) return nativePost({ type: 'notify', title: n.title || 'Tandem', body: n.body || '', chatId: n.chatId || null });
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
  else if (mod && !e.shiftKey && k === 'j') { e.preventDefault(); openQuickAsk({ onSent: optimisticRun }); }
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
await Promise.all([refresh().catch((e) => toast(`Can't reach Tandem: ${e.message}`, 'bad')), loadLogos()]);
connectEvents();
parseRoute();
