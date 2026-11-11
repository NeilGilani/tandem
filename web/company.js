// Company: your Bots as a team of employees. The org chart with who's on shift right now,
// today's shifts, the work board, standups and end-of-day reports, and timesheets.
import { api, h, avatar, userAvatar, icon, toast, modal, menu, md } from './lib.js';
import { S, bot, dmOf, go, on, toggleComputer } from './store.js';
import { openViewer } from './app.js';

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
  let off = { goals: [], meetings: [], channels: [], handbook: '' };
  try { [data, off] = await Promise.all([api('GET', '/api/company'), api('GET', '/api/office')]); } catch (e) { $main.replaceChildren(h('div.page', h('p.hint', e.message))); return; }
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
    avatar(bot(r.bot_id), 26), h('div', h('div.report-h', h('b', bot(r.bot_id)?.name || 'A Bot'), h('span', r.kind === 'eod' ? 'End of day' : r.kind === 'review' ? 'Monthly review' : 'Standup'), h('em', new Date(r.created).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }))),
      h('div.md', { html: md(r.text) })))))
    : h('p.hint', 'Standups appear here as each Bot starts its shift, and end-of-day reports as it finishes.');

  // ---- Goals ------------------------------------------------------------------------------
  const kids = (pid) => off.goals.filter((g) => (g.parent_id || null) === pid);
  const goalRow = (g, depth = 0) => {
    const pct = Math.min(100, Math.round((g.current / g.target) * 100));
    const late = g.due && g.status !== 'done' && new Date(`${g.due}T23:59`) < new Date();
    return [h('button.goal-row', { style: { paddingLeft: `${12 + depth * 22}px` }, on: { click: () => goalModal(g, off.goals) } },
      h('div.goal-h', h('span', g.title), h('em', `${g.current} of ${g.target}${g.unit ? ` ${g.unit}` : ''}`)),
      h('div.goal-bar', h('i', { style: { width: `${pct}%` } })),
      h('div.goal-m', g.owner_id ? bot(g.owner_id)?.name : 'Company', g.due && h('span', { class: late ? 'late' : '' }, ` · ${late ? 'late, ' : ''}due ${g.due}`), g.notes?.length ? ` · ${g.notes.at(-1).text.slice(0, 90)}` : '')),
      ...kids(g.id).flatMap((k) => goalRow(k, depth + 1))];
  };
  const goalsBlock = h('div.goals', off.goals.length ? kids(null).flatMap((g) => goalRow(g)) : h('p.hint', 'Set your company\'s big goals. Department heads break them down and owners keep the numbers current.'),
    h('div', h('button.btn.sm', { on: { click: () => goalModal(null, off.goals) } }, icon('plus'), 'Add a goal')));

  // ---- Meetings -----------------------------------------------------------------------------
  const meetingsBlock = h('div.meetings', off.meetings.map((m) => h('div.meeting',
    h('div.meeting-h', h('b', m.title), m.status === 'running' ? h('span.live-pill', 'In session') : h('span.hint', m.schedule_text || 'One-off')),
    h('div.meeting-p', m.attendees.map((id) => avatar(bot(id), 20)), h('span.hint', `Chaired by ${bot(m.chair_id)?.name || '?'}`)),
    m.last_minutes && h('details.minutes', h('summary', `Last minutes, ${m.last_run ? new Date(m.last_run).toLocaleDateString([], { month: 'short', day: 'numeric' }) : ''}`), h('div.md', { html: md(m.last_minutes) })),
    h('div.hstack', { style: { gap: '6px' } },
      m.status !== 'running' && h('button.btn.sm', { on: { click: () => api('POST', `/api/office/meetings/${m.id}/run`).then(() => { toast(`${m.title} is starting`); go(`#/chat/${m.chat_id}`); }) } }, 'Start now'),
      h('button.btn.ghost.sm', { on: { click: () => go(`#/chat/${m.chat_id}`) } }, m.status === 'running' ? 'Join the room' : 'Open the room'),
      h('button.btn.ghost.sm', { style: { marginLeft: 'auto' }, on: { click: () => api('DELETE', `/api/office/meetings/${m.id}`).then(() => renderCompany(document.getElementById('main'))) } }, 'Cancel meeting')))),
    h('div', h('button.btn.sm', { on: { click: meetingModal } }, icon('plus'), 'Schedule a meeting')));

  // ---- Handbook -----------------------------------------------------------------------------
  const sections = [...(off.handbook || '').matchAll(/^## (.+)$/gm)].map((x) => x[1]);
  const handbookBlock = h('div.handbook',
    h('p.hint', off.handbook ? `${sections.length} section${sections.length === 1 ? '' : 's'}: ${sections.join(', ') || 'none yet'}. Every Bot reads it and follows it over anything else.` : 'No handbook yet. Write the facts and rules every Bot should follow, or ask your chief of staff to draft it.'),
    h('div.hstack', { style: { gap: '6px' } },
      off.handbook && h('button.btn.sm', { on: { click: () => openViewer({ title: 'Company handbook', ref: off.handbookPath }) } }, icon('book'), 'Read it'),
      h('button.btn.sm', { on: { click: () => handbookModal(sections) } }, icon('plus'), off.handbook ? 'Edit a section' : 'Start the handbook')));

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
    h('section.co-sec', h('div.group-h', 'Goals'), goalsBlock),
    h('section.co-sec', h('div.group-h', 'Org chart'), tree),
    h('section.co-sec', h('div.group-h', 'Today'), timeline, h('div.tl-key', h('span', h('i.k-shift'), 'Shift'), h('span', h('i.k-work'), 'Worked'), h('span', h('i.k-now'), 'Now'))),
    h('section.co-sec', h('div.group-h', 'Work board'), board),
    h('section.co-sec', h('div.group-h', 'Meetings'), meetingsBlock),
    h('section.co-sec', h('div.group-h', 'Standups, reports and reviews'), reports,
      h('div', { style: { marginTop: '10px' } }, h('button.btn.ghost.sm', { title: 'Each boss reviews its reports now instead of on the first weekday of the month', on: { click: () => api('POST', '/api/office/reviews').then((r) => toast(r.bosses ? `${r.bosses} boss${r.bosses === 1 ? ' is' : 'es are'} writing reviews` : 'No bosses with reports yet')) } }, 'Run monthly reviews now'))),
    h('section.co-sec', h('div.group-h', 'Handbook'), handbookBlock),
    h('section.co-sec', h('div.group-h', 'Timesheet, last 7 days'), sheet),
    h('label.co-toggle', h('input', { type: 'checkbox', checked: S.settings.draft_reviews === true, on: { change: (e) => api('PATCH', '/api/company', { draft_reviews: e.target.checked }) } }),
      h('span', h('b', 'Bosses review drafts first'), h('span.hint', 'Off: every draft comes straight to you. On: a Bot\'s drafts go to its boss first, which is slower and chattier.'))))));

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
    h('div.hint', `${bot(t.owner_id)?.name || 'A Bot'} · from ${t.assigned_by === 'user' ? (S.me?.owner === false ? S.settings.user_name : 'you') : t.assigned_by === S.me?.id ? 'you' : /^mem_/.test(t.assigned_by) ? (S.members || []).find((x) => x.id === t.assigned_by)?.name || 'a teammate' : bot(t.assigned_by)?.name || 'its boss'}${t.due ? ` · due ${t.due}` : ''} · ${t.status}`),
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

function goalModal(g, all) {
  const title = h('input.input', { value: g?.title || '', placeholder: 'First paying ranch' });
  const target = h('input.input', { type: 'number', value: g?.target ?? '', placeholder: '1', style: { width: '110px' } });
  const current = h('input.input', { type: 'number', value: g?.current ?? 0, style: { width: '110px' } });
  const unit = h('input.input', { value: g?.unit || '', placeholder: 'ranches', style: { width: '140px' } });
  const due = h('input.input', { type: 'date', value: g?.due || '', style: { width: 'auto' } });
  const owner = h('select.select', [h('option', { value: '' }, 'The company'), ...S.bots.map((b) => h('option', { value: b.id, selected: g?.owner_id === b.id }, `${b.name}${b.title ? `, ${b.title}` : ''}`))]);
  const parent = h('select.select', [h('option', { value: '' }, 'Nothing (top level)'), ...all.filter((x) => x.id !== g?.id).map((x) => h('option', { value: x.id, selected: g?.parent_id === x.id }, x.title))]);
  const how = h('input.input', { value: g?.how || '', placeholder: 'Signed agreements in the pipeline file' });
  modal({ title: g ? 'Goal' : 'Add a goal', body: [
    h('div.field', h('label', 'Goal'), title),
    h('div.hstack', { style: { gap: '10px', flexWrap: 'wrap' } }, h('div.field', h('label', 'Now'), current), h('div.field', h('label', 'Target'), target), h('div.field', h('label', 'Unit'), unit), h('div.field', h('label', 'Due'), due)),
    h('div.field', h('label', 'Owner'), owner), h('div.field', h('label', 'Rolls up to'), parent), h('div.field', h('label', 'How it\'s measured'), how),
    g?.notes?.length ? h('div.notes', g.notes.slice().reverse().slice(0, 6).map((n) => h('div.note', h('div.hint', `${new Date(n.at).toLocaleDateString([], { month: 'short', day: 'numeric' })} · ${n.by === 'user' ? 'You' : bot(n.by)?.name || ''}`), h('div', n.text)))) : null,
  ], actions: [{ label: 'Cancel' }, { label: g ? 'Save' : 'Add goal', primary: true, onClick: async () => {
    const body = { title: title.value.trim(), target: Number(target.value), current: Number(current.value) || 0, unit: unit.value.trim(), due: due.value || null, ownerId: owner.value || null, parentId: parent.value || null, how: how.value.trim() };
    try { g ? await api('PATCH', `/api/office/goals/${g.id}`, body) : await api('POST', '/api/office/goals', body); } catch (e) { toast(e.message, 'bad'); return false; }
    renderCompany(document.getElementById('main'));
  } }] });
}

function meetingModal() {
  const title = h('input.input', { placeholder: 'Weekly pipeline review' });
  const chair = h('select.select', S.bots.map((b) => h('option', { value: b.id, selected: /chief/i.test(b.title || '') }, `${b.name}${b.title ? `, ${b.title}` : ''}`)));
  const people = h('div.pick-list', S.bots.map((b) => h('label.list-row', h('input', { type: 'checkbox', value: b.id }), avatar(b, 20), h('span.grow', `${b.name}${b.title ? `, ${b.title}` : ''}`))));
  const when = h('input.input', { placeholder: 'Mondays at 9:30am (leave empty for once, now)' });
  const agenda = h('textarea.textarea', { rows: 3, placeholder: 'Pipeline by stage, what moved, blockers, decide this week\'s priorities' });
  modal({ title: 'Schedule a meeting', wide: true, body: [h('div.field', h('label', 'Meeting'), title), h('div.field', h('label', 'Chaired by'), chair), h('div.field', h('label', 'Attendees'), people), h('div.field', h('label', 'When'), when), h('div.field', h('label', 'Agenda'), agenda)],
    actions: [{ label: 'Cancel' }, { label: 'Schedule', primary: true, onClick: async () => {
      const attendees = [...people.querySelectorAll('input:checked')].map((x) => x.value);
      if (!title.value.trim()) { toast('Name the meeting', 'bad'); return false; }
      try {
        const m = await api('POST', '/api/office/meetings', { title: title.value.trim(), chairId: chair.value, attendees, when: when.value.trim(), agenda: agenda.value.trim() });
        if (!when.value.trim()) await api('POST', `/api/office/meetings/${m.id}/run`);
        toast(when.value.trim() ? `Scheduled: ${m.schedule_text || when.value}` : `${m.title} is starting`);
      } catch (e) { toast(e.message, 'bad'); return false; }
      renderCompany(document.getElementById('main'));
    } }] });
}

function handbookModal(sections) {
  const section = h('input.input', { placeholder: 'Pricing', list: 'hb-sections' });
  const list = h('datalist', { id: 'hb-sections' }, sections.map((x) => h('option', { value: x })));
  const text = h('textarea.textarea', { rows: 10, placeholder: 'Write it the way you\'d brief a new hire.' });
  modal({ title: 'Edit the handbook', wide: true, body: [h('div.field', h('label', 'Section'), section, list), h('div.field', h('label', 'Text (replaces the section)'), text)],
    actions: [{ label: 'Cancel' }, { label: 'Save', primary: true, onClick: async () => {
      if (!section.value.trim() || !text.value.trim()) { toast('Name the section and write it', 'bad'); return false; }
      await api('PUT', '/api/office/handbook', { section: section.value.trim(), text: text.value.trim() });
      toast('Handbook updated. Every Bot follows it from its next turn.');
      renderCompany(document.getElementById('main'));
    } }] });
}
