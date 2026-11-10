// Company: your Bots as a team of employees. The org chart with who's on shift right now,
// today's shifts, the work board, standups and end-of-day reports, and timesheets.
import { api, h, avatar, userAvatar, icon, toast, modal, menu, md } from './lib.js';
import { S, bot, dmOf, go, on, toggleComputer } from './store.js';

let data = null;
const DAY_START = 7, DAY_END = 19;

const hourNow = () => { const d = new Date(); return d.getHours() + d.getMinutes() / 60; };
const shiftOf = (botId) => (data?.shifts || []).find((s) => s.botId === botId);
const parseHours = (h) => { const m = String(h || '').match(/(weekdays|daily)\s+(\d{1,2})-(\d{1,2})/); return m ? { from: +m[2], to: +m[3], weekdays: m[1] === 'weekdays' } : null; };
function onShift(botId) {
  const sh = parseHours(shiftOf(botId)?.hours);
  if (!sh) return false;
  const d = new Date();
  if (sh.weekdays && (d.getDay() === 0 || d.getDay() === 6)) return false;
  return hourNow() >= sh.from && hourNow() < sh.to;
}
function presence(botId) {
  const run = S.runs.find((r) => r.botId === botId);
  if (run) return { cls: 'working', line: run.status || 'Working' };
  if (shiftOf(botId)?.status === 'blocked' || (S.pending || []).some((m) => m.bot_id === botId && m.card?.type !== 'draft')) return { cls: 'blocked', line: 'Waiting on you' };
  if (onShift(botId)) return { cls: 'on', line: 'On shift' };
  const sh = parseHours(shiftOf(botId)?.hours);
  return { cls: 'off', line: sh ? `Off shift, back at ${sh.from > 12 ? `${sh.from - 12} pm` : `${sh.from} am`}` : 'No shift set' };
}
const fmtH = (h) => (h === 12 ? '12 pm' : h > 12 ? `${h - 12} pm` : `${h} am`);

export async function renderCompany($main) {
  try { data = await api('GET', '/api/company'); } catch (e) { $main.replaceChildren(h('div.page', h('p.hint', e.message))); return; }
  const byId = Object.fromEntries(data.org.map((o) => [o.id, o]));
  const roots = data.org.filter((o) => !o.bossId || !byId[o.bossId]);

  // ---- Org chart ------------------------------------------------------------------------
  const node = (o) => {
    const b = bot(o.id);
    const p = presence(o.id);
    const sh = parseHours(shiftOf(o.id)?.hours);
    return h('li', h(`button.org-node.p-${p.cls}`, { on: { click: (e) => nodeMenu(e, o) } },
      avatar(b, 30, { busy: p.cls === 'working' }),
      h('span.on-dot'),
      h('div.org-t', h('b', b?.name || o.name), h('span', o.title || 'No title yet'), h('em', p.line)),
      sh && h('span.org-shift', `${fmtH(sh.from)} to ${fmtH(sh.to)}`)),
    o.reports.length ? h('ul', o.reports.map((id) => byId[id]).filter(Boolean).map(node)) : null);
  };
  const tree = h('div.org-wrap', h('ul.org', h('li', h('div.org-node.founder', userAvatar(30), h('div.org-t', h('b', S.settings.user_name || 'You'), h('span', 'Founder'), h('em', 'Gets only what needs you'))),
    h('ul', roots.map(node)))));

  // ---- Today's shifts -----------------------------------------------------------------------
  const pct = (hr) => `${Math.max(0, Math.min(100, ((hr - DAY_START) / (DAY_END - DAY_START)) * 100))}%`;
  const hourOf = (t) => { const d = new Date(t); return d.getHours() + d.getMinutes() / 60; };
  const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
  const rows = data.org.map((o) => {
    const sh = parseHours(shiftOf(o.id)?.hours);
    const blocks = (data.worked || []).filter((w) => w.bot_id === o.id && w.created >= startOfDay.getTime());
    const run = S.runs.find((r) => r.botId === o.id);
    return [h('div.tl-who', avatar(bot(o.id), 18), h('span', bot(o.id)?.name || o.name)),
      h('div.tl-bar',
        sh && h('i.tl-shift', { style: { left: pct(sh.from), width: `calc(${pct(sh.to)} - ${pct(sh.from)})` } }),
        ...blocks.map((w) => h('i.tl-work', { title: 'Working', style: { left: pct(hourOf(w.created)), width: `max(3px, calc(${pct(hourOf(w.ended || Date.now()))} - ${pct(hourOf(w.created))}))` } })),
        run && h('i.tl-work.now', { style: { left: pct(hourOf(run.started)), width: `max(3px, calc(${pct(hourNow())} - ${pct(hourOf(run.started))}))` } }))];
  });
  const ticks = [];
  for (let hr = DAY_START; hr <= DAY_END; hr += 2) ticks.push(h('span', { style: { left: pct(hr) } }, fmtH(hr)));
  const timeline = h('div.tl', h('div.tl-grid', ...rows.flat(), h('div'), h('div.tl-ticks', ...ticks)),
    h('div.tl-now', { style: { left: `calc(140px + (100% - 140px) * ${(Math.max(DAY_START, Math.min(DAY_END, hourNow())) - DAY_START) / (DAY_END - DAY_START)})` } }));

  // ---- Work board -------------------------------------------------------------------------
  const COLS = [['todo', 'To do'], ['doing', 'Doing'], ['blocked', 'Blocked'], ['review', 'In review'], ['done', 'Done']];
  const board = h('div.board', COLS.map(([k, label]) => {
    const list = data.tasks.filter((t) => t.status === k);
    return h('div.board-col', h('div.board-h', label, h('span', String(list.length))),
      list.length ? list.slice(0, 12).map(taskCard) : h('div.board-empty', k === 'review' ? 'Nothing waiting on a boss' : k === 'blocked' ? 'Nobody is stuck' : '—'));
  }));

  // ---- Standups -------------------------------------------------------------------------
  const reports = data.reports.length ? h('div.reports', data.reports.slice().reverse().map((r) => h('div.report',
    avatar(bot(r.bot_id), 26), h('div', h('div.report-h', h('b', bot(r.bot_id)?.name || 'A Bot'), h('span', r.kind === 'eod' ? 'End of day' : 'Standup'), h('em', new Date(r.created).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }))),
      h('div.md', { html: md(r.text) })))))
    : h('p.hint', 'Standups appear here as each Bot starts its shift, and end-of-day reports as it finishes.');

  // ---- Timesheet ------------------------------------------------------------------------
  const ts = data.timesheet;
  const totalH = ts.reduce((n, t) => n + t.hours, 0);
  const sheet = h('div.sheet',
    h('div.sheet-row.head', h('span', 'Employee'), h('span', 'Worked'), h('span', 'Sessions'), h('span', 'Shipped'), h('span', 'Sent back'), h('span', 'Drafts'), h('span', 'Share of plan used')),
    ...ts.map((t) => h('div.sheet-row', h('span.who', avatar(bot(t.botId), 20), bot(t.botId)?.name), h('span', t.minutes < 60 ? `${t.minutes} min` : `${t.hours.toFixed(1)} h`), h('span', String(t.sessions)), h('span', String(t.tasksDone)),
      h('span', { class: t.sentBack ? 'warn' : '' }, String(t.sentBack)), h('span', String(t.drafts)), h('span.share', h('i', { style: { width: `${t.share}%` } }), `${t.share}%`))));

  const name = h('input.co-name', { value: data.name || '', placeholder: 'Your company name', on: { change: (e) => api('PATCH', '/api/company', { name: e.target.value }).then(() => toast('Saved')) } });
  const working = S.runs.filter((r) => !r.squadId).length;
  const on = data.org.filter((o) => onShift(o.id) || S.runs.some((r) => r.botId === o.id)).length;
  $main.replaceChildren(h('div.page.company', h('div.page-in',
    h('div.co-head', h('div', name, h('p.lede', `${data.org.length} employees · ${on} on shift · ${working} working right now · ${totalH >= 1 ? `${totalH.toFixed(0)} hours` : `${ts.reduce((n, t) => n + t.minutes, 0)} minutes`} worked this week`)),
      h('button.btn.primary', { on: { click: () => assignModal() } }, icon('plus'), 'Assign work')),
    h('section.co-sec', h('div.group-h', 'Org chart'), tree),
    h('section.co-sec', h('div.group-h', 'Today'), timeline, h('div.tl-key', h('span', h('i.k-shift'), 'Shift'), h('span', h('i.k-work'), 'Worked'), h('span', h('i.k-now'), 'Now'))),
    h('section.co-sec', h('div.group-h', 'Work board'), board),
    h('section.co-sec', h('div.group-h', 'Standups and end-of-day reports'), reports),
    h('section.co-sec', h('div.group-h', 'Timesheet, last 7 days'), sheet),
    h('label.co-toggle', h('input', { type: 'checkbox', checked: S.settings.draft_reviews !== false, on: { change: (e) => api('PATCH', '/api/company', { draft_reviews: e.target.checked }) } }),
      h('span', h('b', 'Bosses review drafts first'), h('span.hint', 'A Bot\'s outgoing drafts go to its boss before your inbox. Bots reporting to you come straight to you.'))))));

  function nodeMenu(e, o) {
    const r = e.currentTarget.getBoundingClientRect();
    const b = bot(o.id);
    menu(r.left, r.bottom + 4, [
      { label: 'Open chat', onClick: () => go(`#/chat/${dmOf(o.id)?.id}`) },
      { label: S.settings.computer_mode === 'laptop' ? 'See its laptop' : 'See its computer', onClick: () => { S.focusBot = o.id; toggleComputer(true); } },
      { label: 'Assign work', onClick: () => assignModal(o.id) },
      { label: 'Change title or boss', onClick: () => roleModal(o) },
    ]);
  }
}

function taskCard(t) {
  const b = bot(t.owner_id);
  const late = t.due && t.status !== 'done' && new Date(`${t.due}T23:59`) < new Date();
  return h('button.task', { on: { click: () => taskModal(t) } },
    h('b', t.title),
    h('div.task-m', avatar(b, 16), h('span', b?.name || 'A Bot'), t.due && h('em', { class: late ? 'late' : '' }, late ? `Late, due ${t.due}` : `Due ${t.due}`)),
    t.status === 'review' && t.reviewer_id && h('div.task-r', `With ${bot(t.reviewer_id)?.name || 'its boss'} for review`));
}

function taskModal(t) {
  const notes = (t.notes || []).slice().reverse();
  const actions = [];
  if (t.status === 'review') actions.push({ label: 'Send back', onClick: async () => { const n = prompt('What should they fix?'); if (n == null) return false; await api('PATCH', `/api/company/tasks/${t.id}`, { verdict: 'send_back', notes: n }); renderCompany(document.getElementById('main')); } },
    { label: 'Approve', primary: true, onClick: async () => { await api('PATCH', `/api/company/tasks/${t.id}`, { verdict: 'approve' }); renderCompany(document.getElementById('main')); } });
  else actions.push({ label: 'Close' });
  modal({ title: t.title, wide: true, body: [
    h('div.hint', `${bot(t.owner_id)?.name || 'A Bot'} · from ${t.assigned_by === 'user' ? 'you' : bot(t.assigned_by)?.name || 'its boss'}${t.due ? ` · due ${t.due}` : ''} · ${t.status}`),
    t.detail && h('div.md', { html: md(t.detail) }),
    t.result && [h('div.group-h', 'Result'), h('div.md', { html: md(t.result) })],
    notes.length ? [h('div.group-h', 'Notes'), h('div.notes', notes.map((n) => h('div.note', h('div.hint', `${new Date(n.at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} · ${n.by === 'user' ? 'You' : bot(n.by)?.name || 'A Bot'}`), h('div', n.text))))] : null,
  ], actions });
}

function assignModal(ownerId) {
  const sel = h('select.select', S.bots.map((b) => h('option', { value: b.id, selected: b.id === ownerId }, `${b.name}${b.title ? `, ${b.title}` : ''}`)));
  const title = h('input.input', { placeholder: 'Draft a one-page Sunol results summary' });
  const detail = h('textarea.textarea', { rows: 4, placeholder: 'What good looks like, where things are, what to hand back' });
  const due = h('input.input', { type: 'date', style: { width: 'auto' } });
  modal({ title: 'Assign work', body: [
    h('div.field', h('label', 'To'), sel), h('div.field', h('label', 'Assignment'), title), h('div.field', h('label', 'Details'), detail), h('div.field', h('label', 'Due (optional)'), due),
  ], actions: [{ label: 'Cancel' }, { label: 'Assign', primary: true, onClick: async () => {
    if (!title.value.trim()) { toast('Give it a title', 'bad'); return false; }
    await api('POST', '/api/company/tasks', { ownerId: sel.value, title: title.value.trim(), detail: detail.value.trim(), due: due.value || null });
    toast(`${bot(sel.value)?.name} is on it`);
    renderCompany(document.getElementById('main'));
  } }] });
  setTimeout(() => title.focus(), 30);
}

function roleModal(o) {
  const title = h('input.input', { value: o.title || '', placeholder: 'Head of sales' });
  const boss = h('select.select', [h('option', { value: 'user', selected: !o.bossId }, `${S.settings.user_name || 'You'} (founder)`),
    ...S.bots.filter((b) => b.id !== o.id).map((b) => h('option', { value: b.id, selected: b.id === o.bossId }, `${b.name}${b.title ? `, ${b.title}` : ''}`))]);
  modal({ title: `${bot(o.id)?.name}'s role`, body: [h('div.field', h('label', 'Job title'), title), h('div.field', h('label', 'Reports to'), boss)],
    actions: [{ label: 'Cancel' }, { label: 'Save', primary: true, onClick: async () => {
      try { await api('PATCH', `/api/company/bots/${o.id}`, { title: title.value.trim(), bossId: boss.value }); } catch (e) { toast(e.message, 'bad'); return false; }
      renderCompany(document.getElementById('main'));
    } }] });
}

let t;
for (const evt of ['company', 'run', 'bots']) on(evt, () => { if (S.route.name === 'company') { clearTimeout(t); t = setTimeout(() => renderCompany(document.getElementById('main')), 400); } });
