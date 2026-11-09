// Tandem web app: sidebar, conversations, cards, composer, palette, shortcuts.
import { api, h, md, avatar, userAvatar, icon, toast, modal, confirm, menu, time, fileUrl, SHAPES, COLORS, logo } from './lib.js';
import { S, on, refresh, bot, chat, dmOf, runsIn, go, parseRoute, toggleComputer, connectEvents } from './store.js';
import { renderComputer } from './computer.js';
import { openBotDrawer } from './drawer.js';
import { renderApps, renderSkills, renderSettings, renderTemplates } from './pages.js';

const $sidebar = document.getElementById('sidebar');
const $main = document.getElementById('main');
const $app = document.getElementById('app');

// ---------- Theme -----------------------------------------------------------------------
function applyTheme() {
  const t = S.settings.theme || 'system';
  if (t === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
}

// ---------- Sidebar ---------------------------------------------------------------------
let renaming = null;
let showHidden = false;

function botRow(b) {
  const dm = dmOf(b.id);
  const active = S.route.name === 'chat' && dm && S.route.id === dm.id;
  const running = S.runs.some((r) => r.botId === b.id);
  const last = dm && S.messages[dm.id]?.at(-1);
  if (renaming === b.id) {
    const input = h('input.sb-rename', { value: b.name, on: {
      keydown: async (e) => {
        if (e.key === 'Enter') { await api('PATCH', `/api/bots/${b.id}`, { name: input.value.trim() || b.name }); renaming = null; renderSidebar(); }
        if (e.key === 'Escape') { renaming = null; renderSidebar(); }
      },
      blur: () => { renaming = null; renderSidebar(); },
    } });
    setTimeout(() => { input.focus(); input.select(); });
    return h('div.sb-item', avatar(b, 24), input);
  }
  return h(`button.sb-item${active ? '.active' : ''}`, {
    on: {
      click: () => dm && go(`#/chat/${dm.id}`),
      dblclick: () => { renaming = b.id; renderSidebar(); },
      contextmenu: (e) => { e.preventDefault(); botMenu(b, e.clientX, e.clientY); },
    },
  }, avatar(b, 24),
  h('span.name', b.name, last?.text ? h('span.sub', { style: { display: 'block' } }, last.text.replace(/[`*#>_]+/g, '').slice(0, 60)) : (b.label ? h('span.sub', { style: { display: 'block' } }, b.label) : null)),
  b.is_primary ? h('span.primary-tag', 'Primary') : null,
  running ? h('span.dot', { title: 'Working' }) : null);
}

export function botMenu(b, x, y) {
  const sections = [...new Set([...S.sections.map((s) => s.name), ...S.bots.map((x) => x.section).filter(Boolean)])];
  menu(x, y, [
    { label: 'Open details', onClick: () => openBotDrawer(b.id) },
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
  modal({ title: 'Choose your primary Bot', body: [h('p.hint', 'Your primary Bot is your main point of contact. Imported memory goes to it.'), list],
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

function renderSidebar() {
  const visible = S.bots.filter((b) => !b.hidden);
  const hidden = S.bots.filter((b) => b.hidden);
  const primary = visible.find((b) => b.is_primary);
  const pinned = visible.filter((b) => b.pinned && !b.is_primary);
  const rest = visible.filter((b) => !b.pinned && !b.is_primary);
  const sections = [...new Set(rest.map((b) => b.section).filter(Boolean))];
  const groups = S.chats.filter((c) => c.kind === 'group');

  const nav = (route, label, ic) => h(`button.sb-item${S.route.name === route ? '.active' : ''}`, { on: { click: () => go(`#/${route}`) } }, icon(ic), h('span.name', label));

  $sidebar.replaceChildren(
    h('div.sb-top',
      h('div.brand', h('img', { src: '/icon.svg', alt: '' }), 'Tandem'),
      h('button.icon-btn', { title: 'Computer', on: { click: () => toggleComputer() } }, icon('monitor')),
      h('button.icon-btn', { title: 'New (⌘N)', on: { click: (e) => menu(e.clientX, e.clientY, [
        { label: 'Create a Bot', onClick: newBot },
        { label: 'New Group Chat', onClick: newGroup },
        { label: 'Bot templates', onClick: () => go('#/templates') },
      ]) } }, icon('plus'))),
    h('button.search-btn', { on: { click: openPalette } }, icon('search'), 'Search', h('kbd', '⌘K')),
    h('div.sb-scroll',
      S.bots.length === 0 && h('div.hint', { style: { padding: '8px' } }, 'No Bots yet. Create one to get started.'),
      primary && [h('div.sb-label', 'Primary'), botRow(primary)],
      pinned.length > 0 && [h('div.sb-label', 'Pinned'), pinned.map(botRow)],
      sections.map((s) => [h('div.sb-label', s), rest.filter((b) => b.section === s).map(botRow)]),
      rest.filter((b) => !b.section).length > 0 && [h('div.sb-label', 'Bots', h('button', { on: { click: newBot } }, '+ New')), rest.filter((b) => !b.section).map(botRow)],
      groups.length ? [h('div.sb-label', 'Group chats', h('button', { on: { click: newGroup } }, '+ New')), groups.map((g) => {
        const members = g.bot_ids.map(bot).filter(Boolean);
        const active = S.route.name === 'chat' && S.route.id === g.id;
        return h(`button.sb-item${active ? '.active' : ''}`, {
          on: { click: () => go(`#/chat/${g.id}`), contextmenu: (e) => { e.preventDefault(); groupMenu(g, e.clientX, e.clientY); } },
        }, h('span.av-group', members.slice(0, 3).map((m) => avatar(m, 20))), h('span.name', g.name),
        S.runs.some((r) => r.chatId === g.id) ? h('span.dot') : null);
      })] : null,
      hidden.length ? [h('div.sb-label', h('button', { style: { marginLeft: 0 }, on: { click: () => { showHidden = !showHidden; renderSidebar(); } } }, `${showHidden ? '▾' : '▸'} Hidden Bots (${hidden.length})`)),
        showHidden && hidden.map(botRow)] : null),
    h('div.sb-foot',
      nav('apps', 'Connect apps', 'apps'),
      nav('skills', 'Skills', 'book'),
      nav('settings', 'Settings', 'gear')),
  );
}

function groupMenu(g, x, y) {
  menu(x, y, [
    { label: 'Rename', onClick: () => promptText('Rename group', 'Name', g.name).then((n) => n && api('PATCH', `/api/chats/${g.id}`, { name: n })) },
    { label: 'Edit members', onClick: () => newGroup(g) },
    { label: 'Delete group', danger: true, onClick: async () => { if (await confirm(`Delete "${g.name}"?`)) { await api('DELETE', `/api/chats/${g.id}`); go('#/'); } } },
  ]);
}

// ---------- New Bot / group -------------------------------------------------------------
export function newBot() {
  let shape = SHAPES[S.bots.length % SHAPES.length], color = COLORS[S.bots.length % COLORS.length];
  const name = h('input.input', { placeholder: 'e.g. Inbox, Sales Outbound, Research' });
  const preview = h('div');
  const shapes = h('div.shape-pick');
  const colors = h('div.color-pick');
  const draw = () => {
    preview.replaceChildren(avatar({ name: name.value || '?', shape, color }, 56));
    shapes.replaceChildren(...SHAPES.map((s) => h(`button${s === shape ? '.on' : ''}`, { type: 'button', on: { click: () => { shape = s; draw(); } } }, avatar({ name: name.value || '?', shape: s, color }, 34))));
    colors.replaceChildren(...COLORS.map((c) => h(`button${c === color ? '.on' : ''}`, { type: 'button', style: { background: c }, on: { click: () => { color = c; draw(); } } })));
  };
  name.addEventListener('input', draw);
  draw();
  const create = async () => {
    if (!name.value.trim()) { toast('Give your Bot a name', 'bad'); return false; }
    const r = await api('POST', '/api/bots', { name: name.value.trim(), shape, color });
    await refresh();
    go(`#/chat/${r.chat.id}`);
  };
  name.addEventListener('keydown', (e) => { if (e.key === 'Enter') create().then((ok) => ok !== false && document.querySelector('.modal-bg')?.remove()); });
  modal({ title: 'Create New Bot', body: [
    h('div.row', preview, h('div.field', { style: { flex: 1 } }, h('label', 'Name'), name)),
    h('div.field', h('label', 'Picture'), shapes, colors),
    h('p.hint', { style: { margin: 0 } }, "Tell your Bot its job, sources and approval boundaries in your first message. It'll remember them."),
  ], actions: [{ label: 'Cancel' }, { label: 'Create', primary: true, onClick: create }] });
}

export function newGroup(existing) {
  const picked = new Set(existing?.bot_ids || []);
  const name = h('input.input', { value: existing?.name || '', placeholder: 'Generated from members if empty' });
  const list = h('div.list', S.bots.map((b) => h('label.list-row',
    h('input', { type: 'checkbox', checked: picked.has(b.id), on: { change: (e) => e.target.checked ? picked.add(b.id) : picked.delete(b.id) } }),
    avatar(b, 24), h('span.grow', b.name, b.label && h('small', b.label)))));
  modal({ title: existing ? 'Edit group' : 'New Group Chat', body: [
    h('div.field', h('label', 'To: (two to six Bots)'), list),
    h('div.field', h('label', 'Name'), name),
  ], actions: [{ label: 'Cancel' }, { label: existing ? 'Save' : 'Create', primary: true, onClick: async () => {
    if (picked.size < 2 || picked.size > 6) { toast('Pick two to six Bots', 'bad'); return false; }
    if (existing) await api('PATCH', `/api/chats/${existing.id}`, { botIds: [...picked], name: name.value.trim() || existing.name });
    else { const g = await api('POST', '/api/chats', { botIds: [...picked], name: name.value.trim() }); await refresh(); go(`#/chat/${g.id}`); }
  } }] });
}

// ---------- Chat view ---------------------------------------------------------------------
let replyTo = null;
let pendingFiles = [];
const expandedThreads = new Set();

async function loadMessages(chatId) {
  const r = await api('GET', `/api/chats/${chatId}/messages`);
  S.messages[chatId] = r.messages;
  for (const run of r.runs) if (!S.runs.some((x) => x.id === run.id)) S.runs.push({ ...run, chatId });
}

function authorOf(m) {
  if (m.author === 'user') return { name: 'You', av: userAvatar(32) };
  const b = bot(m.bot_id);
  return { name: b?.name || 'Bot', av: avatar(b, 32) };
}

function renderMessage(m, { inThread = false } = {}) {
  if (m.author === 'system') return h(`div.msg.system${m.meta?.error ? '.error' : ''}`, m.text);
  const { name, av } = authorOf(m);
  const body = h('div.body',
    h('div.meta', h('b', name), h('time', time(m.created)), m.meta?.handoff ? h('span.model', 'handoff') : null,
      m.meta?.origin === 'routine' ? h('span.model', 'routine') : null),
    m.meta?.steps?.length > 0 ? stepsBlock(m) : null,
    m.text ? h(`div.text`, m.author === 'user' ? { textContent: m.text } : { html: md(m.text) }) : null,
    m.attachments?.length ? h('div.attach-list', m.attachments.map((a) => /\.(png|jpe?g|gif|webp)$/i.test(a.name)
      ? h('a.attach', { href: fileUrl(a.path), target: '_blank' }, h('img', { src: fileUrl(a.path), alt: a.name }))
      : h('a.attach', { href: fileUrl(a.path, true) }, icon('clip'), a.name))) : null,
    m.card ? renderCard(m) : null,
    Object.keys(m.reactions || {}).length ? h('div.reactions', Object.keys(m.reactions).map((e) => h('button', { on: { click: () => api('POST', `/api/messages/${m.id}/react`, { emoji: e }) } }, e))) : null,
  );
  return h(`div.msg.${m.author}`, { 'data-id': m.id }, av, body,
    h('div.tools',
      ['👍', '✅', '👀', '❤️'].map((e) => h('button', { title: 'React', on: { click: () => api('POST', `/api/messages/${m.id}/react`, { emoji: e }) } }, e)),
      !inThread && h('button', { title: 'Reply in thread', on: { click: () => { replyTo = m; renderComposer(); } } }, '↩︎'),
      m.text && h('button', { title: 'Copy', on: { click: () => { navigator.clipboard.writeText(m.text); toast('Copied'); } } }, '⧉')));
}

const dur = (ms) => { const s = Math.round(ms / 1000); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60 ? `${s % 60}s` : ''}`.trim(); };

function stepsBlock(m) {
  const steps = m.meta.steps;
  const tools = steps.filter((x) => x.k === 'tool').length;
  const label = `Worked for ${dur(m.meta.duration || 0)}${tools ? `, ${tools} step${tools === 1 ? '' : 's'}` : ''}`;
  return h('details.steps', h('summary', label),
    h('ol', steps.map((x) => h(`li.${x.k}`, x.k === 'text' ? { html: md(x.t) } : x.t))));
}

function renderMessages(chatId) {
  const list = S.messages[chatId] || [];
  const roots = list.filter((m) => !m.parent_id);
  const byParent = {};
  for (const m of list) if (m.parent_id) (byParent[m.parent_id] ||= []).push(m);
  const out = [];
  for (const m of roots) {
    out.push(renderMessage(m));
    const replies = byParent[m.id];
    if (replies?.length) {
      if (expandedThreads.has(m.id) || replies.length <= 2) out.push(h('div.thread', replies.map((r) => renderMessage(r, { inThread: true }))));
      else out.push(h('button.thread-toggle', { on: { click: () => { expandedThreads.add(m.id); paintMessages(); } } }, `${replies.length} replies`));
    }
  }
  return out;
}

function statusLine(chatId) {
  const runs = runsIn(chatId);
  if (!runs.length) return null;
  return runs.map((r) => h('div.status-line', h('span.spin'), h('b', bot(r.botId)?.name || 'Bot'),
    h('span.st', r.status), h('span.el', [dur(Date.now() - r.started), r.steps ? `${r.steps} steps` : ''].filter(Boolean).join(', '))));
}

let $messages, $status, $composer, currentChatId = null;

function paintMessages({ keepScroll = false } = {}) {
  if (!$messages || !currentChatId) return;
  const atBottom = $messages.scrollHeight - $messages.scrollTop - $messages.clientHeight < 120;
  const prev = $messages.scrollTop;
  const list = S.messages[currentChatId] || [];
  const wrap = h('div.msg-wrap', list.length ? renderMessages(currentChatId) : emptyChat(currentChatId));
  $messages.replaceChildren(wrap);
  $status.replaceChildren(...[statusLine(currentChatId)].flat().filter(Boolean));
  if (atBottom || !keepScroll) $messages.scrollTop = $messages.scrollHeight; else $messages.scrollTop = prev;
}

function emptyChat(chatId) {
  const c = chat(chatId);
  if (c?.kind === 'group') return h('div.empty', { style: { padding: '60px 0' } }, h('div', h('div.av-group', { style: { justifyContent: 'center' } }, c.bot_ids.map((id) => avatar(bot(id), 44))),
    h('h2', c.name), h('p', 'Write normally and the Bots decide who responds, or @mention one to give it ownership. Use @everyone sparingly.')));
  const b = bot(c?.bot_ids[0]);
  return h('div.empty', { style: { padding: '60px 0' } }, h('div', avatar(b, 64), h('h2', b?.name),
    h('p', 'Give it a job, the sources it should use, and where it needs your approval — then send a real first task with a clear finish line.'),
    h('div.row', { style: { justifyContent: 'center', flexWrap: 'wrap', marginTop: '12px' } },
      ['Your job is to triage my inbox every morning and draft replies. Remember that.', 'Every weekday at 8am, send me a brief of today\'s meetings.', 'Research the 10 best-funded startups in my space and save a sheet.']
        .map((t) => h('button.chip', { on: { click: () => { const ta = $composer.querySelector('textarea'); ta.value = t; ta.focus(); } } }, t.slice(0, 48) + '…')))));
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
    h('button.title', { on: { click: () => isGroup ? newGroup(c) : openBotDrawer(b.id) } },
      isGroup ? h('span.av-group', members.slice(0, 4).map((m) => avatar(m, 28))) : avatar(b, 32),
      h('div', h('b', isGroup ? c.name : b?.name), h('span', isGroup ? members.map((m) => m.name).join(', ') : (b?.label || 'Add a label')))),
    h('div.spacer'),
    h('button.icon-btn', { title: 'Computer', on: { click: () => toggleComputer() } }, icon('monitor')),
    h('button.icon-btn', { title: 'More', on: { click: (e) => menu(e.clientX, e.clientY, [
      ...(!isGroup ? [{ label: 'Details', onClick: () => openBotDrawer(b.id) }, { label: 'Routines', onClick: () => openBotDrawer(b.id, 'routines') }, { label: 'Library', onClick: () => openBotDrawer(b.id, 'library') }] : []),
      ...(!isGroup ? [{ label: 'Teach a task', onClick: () => teachTask(b.id, chatId) }] : []),
      { label: 'Reset conversation', onClick: async () => { if (await confirm('Reset this conversation? Memory, files, routines and settings are kept.', { danger: false, label: 'Reset' })) api('POST', `/api/chats/${chatId}/reset`); } },
      ...(isGroup ? [{ label: 'Edit members', onClick: () => newGroup(c) }, { label: 'Delete group', danger: true, onClick: async () => { if (await confirm(`Delete "${c.name}"?`)) { await api('DELETE', `/api/chats/${c.id}`); go('#/'); } } }] : []),
    ]) } }, icon('more')));

  $messages = h('div.messages');
  $status = h('div');
  $composer = h('div.composer');
  $main.replaceChildren(head, $messages, $status, $composer);
  renderComposer();
  if (S.messages[chatId]) paintMessages();
  loadMessages(chatId).then(() => { if (currentChatId === chatId) paintMessages(); });
}

export function teachTask(botId, chatId) {
  const goal = h('input.input', { placeholder: 'e.g. Download last month’s invoices from the billing portal' });
  modal({ title: 'Teach a task', body: [
    h('p.hint', { style: { margin: 0 } }, 'Describe the result, then do the workflow once in the computer. Recording captures visible computer activity for up to ten minutes — no microphone audio. Avoid showing secrets on screen.'),
    h('div.field', h('label', 'Intended result'), goal),
  ], actions: [{ label: 'Cancel' }, { label: 'Start recording', primary: true, onClick: async () => {
    if (!goal.value.trim()) { toast('Describe the intended result', 'bad'); return false; }
    await api('POST', '/api/computer/teach/start', { chatId, botId, goal: goal.value.trim() });
    toggleComputer(true);
  } }] });
}

// ---------- Cards -------------------------------------------------------------------------
function cardAction(m, payload) {
  return api('POST', `/api/cards/${m.id}`, payload).catch((e) => toast(e.message, 'bad'));
}

function statusPill(status) {
  const map = { allowed: ['Allowed', 'good'], denied: ['Denied', 'bad'], expired: ['Expired', ''], answered: ['Answered', 'good'], saved: ['Saved', 'good'],
    dismissed: ['Not now', ''], connected: ['Connected', 'good'], 'signing-in': ['Signing in…', 'warn'], sent: ['Sent', 'good'], discarded: ['Discarded', ''], done: ['Done', 'good'], pending: ['Waiting for you', 'accent'] };
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
    // Once answered, an approval shrinks to a single quiet line.
    if (!pending) {
      const word = { allowed: 'Allowed', denied: 'Denied', expired: 'Expired' }[c.status] || c.status;
      return h(`div.approval-done.${c.status}`, h('span.dot-s'), h('span', `${word}: ${c.summary}`), c.saved && h('span.saved', c.saved.replace(/^Saved: /, 'Always allowed: ')), details);
    }
    return h('div.card',
      h('div.card-h', commandCard ? 'Run a command on this computer?' : 'Approve this action?', statusPill(c.status)),
      h('div.card-b',
        h('div.card-title', c.summary, c.site && h('span.hint', ` on ${c.site}`)),
        c.reason && h('div.hint', c.reason),
        (c.warnings || []).map((w) => h('div.warn', w)),
        details,
        c.expires && h('div.hint', `Expires at ${time(c.expires)}`)),
      h('div.card-actions',
        h('button.btn.primary', { on: { click: () => cardAction(m, { choice: 'allow' }) } }, c.allowAlways ? 'Allow once' : 'Allow'),
        c.allowAlways && h('button.btn', { on: { click: () => cardAction(m, { choice: 'always' }) } }, c.alwaysLabel || 'Always allow'),
        h('button.btn.danger', { on: { click: () => cardAction(m, { choice: 'deny' }) } }, commandCard ? 'Skip' : ruleCard ? 'Not now' : 'Deny'),
        commandCard && h('button.btn.ghost', { on: { click: () => go('#/settings/computer') } }, 'Settings'),
        ruleCard && h('button.btn.ghost', { on: { click: () => go('#/settings/general') } }, 'Edit rule')));
  }

  if (c.type === 'draft') {
    const fields = { to: c.to, cc: c.cc, subject: c.subject, body: c.body };
    const inputs = {};
    const field = (k, label, multiline) => {
      inputs[k] = multiline ? h('textarea.textarea', { value: fields[k] || '', rows: 8, disabled: !pending }) : h('input.input', { value: fields[k] || '', disabled: !pending });
      return multiline ? inputs[k] : h('div.draft-field', h('label', label), inputs[k]);
    };
    const edits = () => Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, el.value]));
    return h('div.card',
      h('div.card-h', `${c.app} draft`, statusPill(c.status)),
      h('div.card-b', field('to', 'To'), (c.cc || pending) && field('cc', 'Cc'), (c.subject || /mail|outlook/i.test(c.app)) && field('subject', 'Subject'), field('body', '', true),
        c.thread && h('div.hint', `In reply to: ${c.thread}`)),
      pending && h('div.card-actions',
        h('button.btn.primary', { on: { click: () => cardAction(m, { action: 'send', edits: edits() }) } }, 'Send'),
        h('button.btn', { on: { click: () => cardAction(m, { action: 'discard' }) } }, 'Discard'),
        h('button.btn.ghost', { on: { click: () => api('PATCH', `/api/bots/${m.bot_id}`, { drafts: 0 }).then(() => toast(`Drafts off for ${b?.name}. It will send directly (still subject to approvals).`)) } }, 'Turn off drafts for this Bot')));
  }

  if (c.type === 'question') {
    const answerBox = c.fields?.length ? c.fields.map((f) => h('div.field', h('label', f), h('input.input', { 'data-f': f }))) : (!c.options?.length ? [h('textarea.textarea', { rows: 3, 'data-free': 1 })] : []);
    const submit = (val) => {
      let answer = val;
      if (!answer) {
        const el = cardEl.querySelectorAll('[data-f]');
        answer = el.length ? [...el].map((e) => `${e.dataset.f}: ${e.value}`).join('\n') : cardEl.querySelector('[data-free]')?.value;
      }
      if (answer) cardAction(m, { answer });
    };
    const cardEl = h('div.card',
      h('div.card-h', 'Question', statusPill(c.status)),
      h('div.card-b', h('div', c.question), pending ? answerBox : h('div.hint', `Answer: ${c.answer}`)),
      pending && h('div.card-actions', (c.options || []).map((o) => h('button.btn', { on: { click: () => submit(o) } }, o)),
        (answerBox.length > 0) && h('button.btn.primary', { on: { click: () => submit() } }, 'Submit')));
    return cardEl;
  }

  if (c.type === 'secret') {
    const user = h('input.input', { value: c.username || '', placeholder: 'Username or email', autocomplete: 'off' });
    const secret = h('input.input', { type: 'password', placeholder: c.kind === 'secret' ? 'Secret value' : 'Password', autocomplete: 'new-password' });
    return h('div.card',
      h('div.card-h', c.title, statusPill(c.status)),
      h('div.card-b', h('div', c.purpose), c.site && h('div.hint', `For ${c.site}`),
        pending && [c.kind !== 'secret' && user, secret, h('div.hint', 'Saved to your Mac Keychain. The Bot never sees it — the Vault fills it for the Bot.')]),
      pending && h('div.card-actions',
        h('button.btn.primary', { on: { click: () => secret.value && cardAction(m, { username: user.value, secret: secret.value }) } }, 'Save to Vault'),
        h('button.btn', { on: { click: () => cardAction(m, { dismiss: true }) } }, 'Not now')));
  }

  if (c.type === 'connect') {
    return h('div.card',
      h('div.card-h', logo({ name: c.name, color: c.color }, 22), ` Connect ${c.name}`, statusPill(c.status)),
      h('div.card-b', h('div', `${b?.name || 'Your Bot'} needs ${c.name}. Sign in once in the computer's browser — the session is shared by all your Bots.`), c.note && h('div.warn', c.note)),
      (pending || c.status === 'signing-in') && h('div.card-actions',
        c.status === 'signing-in'
          ? [h('button.btn.primary', { on: { click: () => api('POST', '/api/computer/done') } }, "I'm done"), h('button.btn', { on: { click: () => api('POST', '/api/computer/focus') } }, 'Show browser')]
          : [h('button.btn.primary', { on: { click: () => { cardAction(m, {}); toggleComputer(true); } } }, c.note ? 'Reopen' : 'Sign in'),
            h('button.btn', { on: { click: () => cardAction(m, { dismiss: true }) } }, 'Not now')]));
  }

  if (c.type === 'takeover') {
    return h('div.card',
      h('div.card-h', 'Take over the computer', statusPill(c.status)),
      h('div.card-b', h('div', c.reason), h('div.hint', 'Complete only that step in the computer, then press I\'m done.')),
      pending && h('div.card-actions',
        h('button.btn', { on: { click: () => { toggleComputer(true); api('POST', '/api/computer/focus'); } } }, 'Take over'),
        h('button.btn.primary', { on: { click: () => cardAction(m, {}) } }, "I'm done")));
  }

  if (c.type === 'skill_draft') {
    const name = h('input.input', { value: c.name, disabled: !pending });
    const desc = h('input.input', { value: c.description, disabled: !pending });
    const body = h('textarea.textarea', { value: c.body, rows: 12, disabled: !pending, style: { fontFamily: 'var(--mono)', fontSize: '12px' } });
    return h('div.card', { style: { maxWidth: '680px' } },
      h('div.card-h', c.title, statusPill(c.status)),
      h('div.card-b', h('div.field', h('label', 'Name'), name), h('div.field', h('label', 'Description'), desc), body,
        pending && h('div.hint', 'This is a draft from one demonstration. Add decision rules, failure handling and approval boundaries before scheduling it.')),
      pending && h('div.card-actions',
        h('button.btn.primary', { on: { click: () => cardAction(m, { action: 'save', name: name.value, description: desc.value, body: body.value }) } }, 'Save skill'),
        h('button.btn', { on: { click: () => cardAction(m, { action: 'discard' }) } }, 'Discard')));
  }
  return null;
}

// ---------- Composer ------------------------------------------------------------------------
let mentionState = null;
let recognizer = null;

function mentionCandidates(c, q) {
  const ql = q.toLowerCase();
  const out = [];
  const botsIn = c.kind === 'group' ? c.bot_ids.map(bot).filter(Boolean) : S.bots;
  if (c.kind === 'group' && 'everyone'.startsWith(ql)) out.push({ label: 'everyone', sub: 'all Bots in this group', insert: '@everyone ' });
  for (const b of botsIn) if (b.name.toLowerCase().startsWith(ql)) out.push({ label: b.name, sub: 'Bot', insert: `@${b.name} `, av: avatar(b, 20) });
  for (const a of S.connectors) if (a.name.toLowerCase().includes(ql)) out.push({ label: a.name, sub: `app · ${a.status}`, insert: `@${a.name} `, av: logo(a, 20) });
  return out.slice(0, 10);
}

function renderComposer() {
  if (!$composer || !currentChatId) return;
  const c = chat(currentChatId);
  const running = runsIn(currentChatId).length > 0;
  const ta = h('textarea', { rows: 1, placeholder: c?.kind === 'group' ? 'Message the group — @mention a Bot to give it ownership' : `Message ${bot(c?.bot_ids[0])?.name || ''}` });
  const draftKey = `tandem.draft.${currentChatId}`;
  try { ta.value = localStorage.getItem(draftKey) || ''; } catch {}
  const pop = h('div.mention-pop', { hidden: true });
  const sendBtn = h('button.send-btn', { title: 'Send (Enter)', on: { click: send } }, icon('send'));
  const stopBtn = h('button.send-btn.stop-btn', { title: 'Stop now', on: { click: () => api('POST', `/api/chats/${currentChatId}/stop`) } }, icon('stop'));
  const fileInput = h('input', { type: 'file', multiple: true, hidden: true, on: { change: (e) => addFiles(e.target.files) } });
  const mic = h('button.icon-btn', { title: 'Dictate', on: { click: dictate } }, icon('mic'));

  function autosize() { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 260) + 'px'; }
  async function send() {
    const text = ta.value.trim();
    if (!text && !pendingFiles.length) return;
    const body = { text, parentId: replyTo?.id || null, attachments: pendingFiles };
    ta.value = ''; pendingFiles = []; replyTo = null;
    try { localStorage.removeItem(draftKey); } catch {}
    renderComposer();
    try { await api('POST', `/api/chats/${currentChatId}/messages`, body); } catch (e) { toast(e.message, 'bad'); }
  }
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
    pop.hidden = true; mentionState = null; ta.focus();
  }
  ta.addEventListener('input', () => { autosize(); updateMention(); try { localStorage.setItem(draftKey, ta.value); } catch {} });
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
    for (const f of files) {
      try {
        const r = await api('POST', '/api/uploads', f, { headers: { 'X-Filename': encodeURIComponent(f.name), 'Content-Type': f.type || 'application/octet-stream' } });
        pendingFiles.push({ name: r.name, path: r.path, type: r.type });
      } catch (e) { toast(`${f.name}: ${e.message}`, 'bad'); }
    }
    const keep = ta.value;
    renderComposer();
    $composer.querySelector('textarea').value = keep;
  }
  function dictate() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return toast('Dictation isn’t supported in this browser', 'bad');
    if (recognizer) { recognizer.stop(); return; }
    recognizer = new SR();
    recognizer.continuous = true; recognizer.interimResults = true;
    const base = ta.value;
    recognizer.onresult = (e) => { ta.value = base + (base ? ' ' : '') + [...e.results].map((r) => r[0].transcript).join(''); autosize(); };
    recognizer.onend = () => { recognizer = null; mic.classList.remove('mic-on'); };
    recognizer.start();
    mic.classList.add('mic-on');
  }

  $composer.ondragover = (e) => e.preventDefault();
  $composer.ondrop = (e) => { e.preventDefault(); addFiles(e.dataTransfer.files); };

  $composer.replaceChildren(pop, h('div.composer-box',
    replyTo && h('div.replying', '↩︎ Replying in thread to ', h('b', (replyTo.text || replyTo.card?.summary || 'message').slice(0, 60)), h('button', { on: { click: () => { replyTo = null; renderComposer(); } } }, '✕')),
    pendingFiles.length > 0 && h('div.pending-files', pendingFiles.map((f, i) => h('span.attach', icon('clip'), f.name, h('button.icon-btn', { style: { width: '18px', height: '18px' }, on: { click: () => { pendingFiles.splice(i, 1); renderComposer(); } } }, '✕')))),
    ta,
    h('div.composer-bar',
      h('button.icon-btn', { title: 'Attach files', on: { click: () => fileInput.click() } }, icon('clip')), fileInput,
      mic,
      h('button.icon-btn', { title: 'Mention a Bot or app', on: { click: () => { ta.value += (ta.value && !ta.value.endsWith(' ') ? ' ' : '') + '@'; ta.focus(); updateMention(); } } }, '@'),
      h('div.spacer'),
      running && stopBtn,
      sendBtn)));
  autosize();
  setTimeout(() => ta.focus(), 0);
}

// ---------- Home (mobile list, desktop empty state) ---------------------------------------
function renderHome() {
  currentChatId = null;
  if (!S.bots.length) {
    $main.replaceChildren(h('div.empty', h('div',
      h('img', { src: '/icon.svg', width: 64, height: 64, alt: '' }),
      h('h2', 'Welcome to Tandem'),
      h('p', 'Bots are AI coworkers that work on a computer all your Bots share. Give one a job, connect your apps, and message it like a teammate.'),
      h('div.row', { style: { justifyContent: 'center', marginTop: '16px' } },
        h('button.btn.primary', { on: { click: newBot } }, icon('plus'), 'Create primary Bot'),
        h('button.btn', { on: { click: () => go('#/templates') } }, icon('template'), 'Bot templates')))));
    return;
  }
  const primary = S.bots.find((b) => b.is_primary) || S.bots[0];
  const dm = dmOf(primary.id);
  if (dm && innerWidth > 820) return go(`#/chat/${dm.id}`);
  $main.replaceChildren(h('div.empty', 'Choose a Bot'));
}

// ---------- Command palette -----------------------------------------------------------------
export function openPalette() {
  const input = h('input', { placeholder: 'Search messages, Bots, group chats, files, routines… or type a command' });
  const res = h('div.palette-res');
  let items = [], sel = 0;
  const commands = [
    { label: 'Create a Bot', sub: '⌘N', run: newBot },
    { label: 'New Group Chat', sub: '⌘⇧N', run: newGroup },
    { label: 'Connect apps', run: () => go('#/apps') },
    { label: 'Skills', run: () => go('#/skills') },
    { label: 'Bot templates', run: () => go('#/templates') },
    { label: 'Settings', run: () => go('#/settings') },
    { label: 'Toggle computer', run: () => toggleComputer() },
  ];
  const draw = (groups) => {
    items = [];
    res.replaceChildren(...groups.filter((g) => g.items.length).map((g) => [h('div.grp', g.name), g.items.map((it) => {
      const i = items.push(it) - 1;
      return h(`button${i === sel ? '.sel' : ''}`, { on: { click: () => { m.close(); it.run(); } } }, it.av || null, h('span', it.label), it.sub && h('small', it.sub));
    })]).flat());
  };
  let t;
  const search = async () => {
    const q = input.value.trim();
    const cmd = commands.filter((c) => c.label.toLowerCase().includes(q.toLowerCase()));
    if (!q) return draw([{ name: 'Bots', items: S.bots.map((b) => ({ label: b.name, sub: b.label, av: avatar(b, 22), run: () => go(`#/chat/${dmOf(b.id).id}`) })) }, { name: 'Commands', items: cmd }]);
    const r = await api('GET', `/api/search?q=${encodeURIComponent(q)}`);
    draw([
      { name: 'Bots', items: r.bots.map((b) => ({ label: b.name, sub: b.label, av: avatar(b, 22), run: () => go(`#/chat/${dmOf(b.id).id}`) })) },
      { name: 'Group chats', items: r.groups.map((g) => ({ label: g.name, run: () => go(`#/chat/${g.id}`) })) },
      { name: 'Messages', items: r.messages.map((mm) => ({ label: mm.text.slice(0, 80), sub: `${chat(mm.chat_id)?.name || bot(mm.bot_id)?.name || ''} · ${time(mm.created)}`, run: () => go(`#/chat/${mm.chat_id}`) })) },
      { name: 'Routines', items: r.routines.map((x) => ({ label: x.name, sub: bot(x.bot_id)?.name, run: () => openBotDrawer(x.bot_id, 'routines') })) },
      { name: 'Files', items: r.files.map((f) => ({ label: f.title, sub: f.ref, run: () => window.open(/^https?:/.test(f.ref) ? f.ref : fileUrl(f.ref), '_blank') })) },
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

// ---------- Routing -----------------------------------------------------------------------
function render() {
  applyTheme();
  renderSidebar();
  const r = S.route;
  $app.classList.toggle('in-chat', r.name !== 'home');
  $app.classList.toggle('with-computer', S.showComputer);
  if (r.name === 'chat') { if (currentChatId !== r.id || !$messages?.isConnected) renderChat(r.id); else { paintMessages({ keepScroll: true }); renderComposerIfIdle(); } }
  else {
    currentChatId = null;
    if (r.name === 'apps') renderApps($main, r);
    else if (r.name === 'skills') renderSkills($main, r);
    else if (r.name === 'settings') renderSettings($main, r);
    else if (r.name === 'templates') renderTemplates($main, r);
    else renderHome();
  }
  renderComputer();
}

// Re-render the composer only when its run state changed (keeps what you're typing).
let lastRunning = null;
function renderComposerIfIdle() {
  const running = runsIn(currentChatId).length > 0;
  if (running !== lastRunning) {
    lastRunning = running;
    const ta = $composer?.querySelector('textarea');
    const val = ta?.value, focused = document.activeElement === ta;
    renderComposer();
    const nta = $composer.querySelector('textarea');
    if (val != null) nta.value = val;
    if (!focused) nta.blur();
  }
}

on('state', render);
on('route', () => { replyTo = null; pendingFiles = []; render(); });
on('message', (m) => {
  if (m.chat_id === currentChatId) paintMessages({ keepScroll: true });
  renderSidebar();
});
on('run', (r) => {
  if (r.chatId === currentChatId) { $status?.replaceChildren(...[statusLine(currentChatId)].flat().filter(Boolean)); renderComposerIfIdle(); }
  renderSidebar();
});
on('computer-toggle', () => { $app.classList.toggle('with-computer', S.showComputer); renderComputer(); });
on('computer', renderComputer);
on('notify', (n) => {
  const b = bot(n.botId);
  if (b && !b.notify) return;
  if (document.hasFocus() && n.chatId === currentChatId) return;
  if ('Notification' in window && Notification.permission === 'granted') {
    const note = new Notification(n.title || 'Tandem', { body: n.body, icon: '/icon.svg', tag: n.chatId });
    note.onclick = () => { window.focus(); go(`#/chat/${n.chatId}`); };
  } else toast(`${n.title}: ${n.body}`);
});

// Keep the elapsed time on the status line ticking.
setInterval(() => {
  if (currentChatId && $status?.isConnected && runsIn(currentChatId).length) $status.replaceChildren(...[statusLine(currentChatId)].flat().filter(Boolean));
}, 1000);

// ---------- Keyboard shortcuts ---------------------------------------------------------------
document.addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); }
  else if (mod && e.shiftKey && e.key.toLowerCase() === 'n') { e.preventDefault(); newGroup(); }
  else if (mod && !e.shiftKey && e.key.toLowerCase() === 'n') { e.preventDefault(); newBot(); }
  else if (mod && e.key === '.') { e.preventDefault(); if (currentChatId) api('POST', `/api/chats/${currentChatId}/stop`); }
});

// ---------- Boot ------------------------------------------------------------------------------
window.addEventListener('hashchange', parseRoute);
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
if ('Notification' in window && Notification.permission === 'default') {
  document.addEventListener('click', () => Notification.requestPermission(), { once: true });
}
await refresh().catch((e) => toast(`Can't reach Tandem: ${e.message}`, 'bad'));
connectEvents();
parseRoute();
