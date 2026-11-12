// Missions: long-running work a Bot owns until it's done.
import { api, h, avatar, icon, toast, modal, md, confirm, esc, host } from './lib.js';
import { S, bot, dmOf, go, on } from './store.js';

const when = (ts) => {
  if (!ts) return '';
  const d = new Date(ts), now = new Date();
  const t = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return `today ${t}`;
  const tm = new Date(now); tm.setDate(now.getDate() + 1);
  if (d.toDateString() === tm.toDateString()) return `tomorrow ${t}`;
  return `${d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })} ${t}`;
};
export function progress(plan = '') {
  const done = (plan.match(/^\s*[-*] \[x\]/gim) || []).length;
  const total = done + (plan.match(/^\s*[-*] \[ \]/gm) || []).length;
  return { done, total, pct: total ? Math.round((done / total) * 100) : 0 };
}
const working = (m) => S.runs.some((r) => r.botId === m.bot_id && r.origin === 'mission');

export function statusOf(m) {
  if (working(m)) { const r = S.runs.find((x) => x.botId === m.bot_id && x.origin === 'mission'); return { label: 'Working', cls: 'warn spin', line: r?.status || 'Working' }; }
  switch (m.status) {
    case 'waiting': return { label: 'Waiting', cls: '', line: `${m.wake_reason ? `${m.wake_reason}. ` : ''}Wakes ${when(m.next_wake)}` };
    case 'active': return { label: 'Up next', cls: 'warn', line: m.next_wake ? `Next session ${when(m.next_wake)}` : 'Starting' };
    case 'blocked': return { label: 'Needs you', cls: 'bad', line: m.block_reason || 'Waiting for your answer in the chat' };
    case 'paused': return { label: 'Paused', cls: '', line: 'Paused by you' };
    case 'done': return { label: 'Done', cls: 'good', line: (m.summary || 'Finished').split('\n')[0] };
    default: return { label: 'Stopped', cls: '', line: 'Stopped' };
  }
}

// Render a plan checklist with real checkboxes.
function planHtml(plan) {
  if (!plan.trim()) return '<p class="hint">No plan yet. The Bot writes one in its first session.</p>';
  return md(plan.replace(/^(\s*[-*]) \[x\] /gim, '$1 \u0001').replace(/^(\s*[-*]) \[ \] /gm, '$1 \u0002'))
    .replace(/\u0001/g, '<span class="cb on"></span>').replace(/\u0002/g, '<span class="cb"></span>');
}

export function missionCard(m, { compact = false } = {}) {
  const b = bot(m.bot_id);
  const st = statusOf(m);
  const p = progress(m.plan);
  const actions = h('div.m-actions',
    ['active', 'waiting', 'blocked'].includes(m.status) && !working(m) && h('button.btn.sm', { on: { click: (e) => { e.stopPropagation(); api('POST', `/api/missions/${m.id}/now`).then(() => toast('Starting a session')).catch((x) => toast(x.message, 'bad')); } } }, 'Work now'),
    ['active', 'waiting', 'blocked'].includes(m.status) && h('button.btn.ghost.sm', { on: { click: (e) => { e.stopPropagation(); api('POST', `/api/missions/${m.id}/pause`); } } }, 'Pause'),
    m.status === 'paused' && h('button.btn.sm', { on: { click: (e) => { e.stopPropagation(); api('POST', `/api/missions/${m.id}/resume`).catch((x) => toast(x.message, 'bad')); } } }, 'Resume'),
    m.status === 'blocked' && h('button.btn.sm.primary', { on: { click: (e) => { e.stopPropagation(); go(`#/chat/${m.chat_id}`); } } }, 'Answer'));
  return h(`button.mission${compact ? '.compact' : ''}`, { on: { click: () => openMission(m.id) } },
    h('div.m-top', avatar(b, compact ? 26 : 30, { busy: working(m) }),
      h('div.m-t', h('b', m.title), h('span', b?.name || 'Bot')),
      h(`span.pill${st.cls ? '.' + st.cls.split(' ').join('.') : ''}`, st.label)),
    h('div.m-bar', h('i', { style: { width: `${p.total ? p.pct : 0}%` } })),
    h('div.m-meta', h('span', p.total ? `${p.done} of ${p.total} steps` : 'Planning'), h('span', `${m.sessions} session${m.sessions === 1 ? '' : 's'}`)),
    h('div.m-line', st.line),
    !compact && actions);
}

export function openMission(id) {
  const m = (S.missions || []).find((x) => x.id === id);
  if (!m) return;
  const b = bot(m.bot_id);
  const st = statusOf(m);
  const p = progress(m.plan);
  const hours = h('select.select', { style: { width: 'auto' } }, [['any', 'Any time'], ['weekdays 9-18', 'Weekdays 9 to 6'], ['daily 8-22', 'Every day 8 to 10']].map(([v, l]) => h('option', { value: v, selected: m.hours === v }, l)));
  hours.addEventListener('change', () => api('PATCH', `/api/missions/${id}`, { hours: hours.value }).then(() => toast('Working hours saved')));
  const budget = h('input.input', { type: 'number', min: 1, max: 200, value: m.daily_budget, style: { width: '80px' } });
  budget.addEventListener('change', () => api('PATCH', `/api/missions/${id}`, { daily_budget: Number(budget.value) }).then(() => toast('Daily limit saved')));
  const notes = [...(m.notes || [])].reverse();
  const box = modal({ title: null, wide: true, body: [
    h('div.m-head', avatar(b, 40, { busy: working(m) }), h('div', { style: { flex: 1, minWidth: 0 } }, h('h2', m.title), h('div.hint', `${b?.name} · started ${when(m.created)} · ${m.sessions} sessions`)),
      h(`span.pill${st.cls ? '.' + st.cls.split(' ').join('.') : ''}`, st.label)),
    h('div.m-line', { style: { fontSize: '13.5px' } }, st.line),
    h('div', h('div.m-bar.big', h('i', { style: { width: `${p.pct}%` } })), h('div.hint', { style: { marginTop: '6px' } }, p.total ? `${p.done} of ${p.total} steps done` : 'No plan yet')),
    h('div.m-grid',
      h('div', h('div.group-h', 'Goal'), h('div', m.goal), m.done_when && [h('div.group-h', 'Done when'), h('div', m.done_when)],
        m.summary && [h('div.group-h', 'Result'), h('div.md', { html: md(m.summary) })],
        h('div.group-h', 'Plan'), h('div.plan', { html: planHtml(m.plan || '') })),
      h('div', h('div.group-h', 'Notes'), notes.length ? h('div.notes', notes.map((n) => h('div.note', h('div.hint', `${when(n.at)} · session ${n.session}${n.next && n.next !== 'continue' ? ` · ${n.next}` : ''}`), h('div', n.text)))) : h('p.hint', 'Notes appear after each work session.'),
        h('div.group-h', 'Pace'), h('div.hstack', { style: { flexWrap: 'wrap' } }, h('span.hint', 'Works'), hours, h('span.hint', 'up to'), budget, h('span.hint', 'sessions a day')))),
  ], actions: [
    { label: 'Delete', danger: true, onClick: async () => { if (!await confirm('Delete this mission and its notes? Work already done is kept.')) return false; await api('DELETE', `/api/missions/${id}`); } },
    ...(['active', 'waiting', 'blocked', 'paused'].includes(m.status) ? [{ label: 'Stop', onClick: async () => { if (!await confirm('Stop this mission? The Bot finishes its current step and won’t pick it back up.', { danger: true, label: 'Stop' })) return false; await api('POST', `/api/missions/${id}/stop`); } }] : []),
    ...(m.status === 'paused' ? [{ label: 'Resume', onClick: () => api('POST', `/api/missions/${id}/resume`) }] : ['active', 'waiting', 'blocked'].includes(m.status) ? [{ label: 'Pause', onClick: () => api('POST', `/api/missions/${id}/pause`) }] : []),
    { label: 'Open chat', primary: true, onClick: () => go(`#/chat/${m.chat_id}`) },
  ] });
  box.box.classList.add('mission-modal');
}

export function newMission(botId) {
  const bots = S.bots.filter((b) => !b.hidden);
  let pick = botId || (bots.find((b) => b.is_primary) || bots[0])?.id;
  const sel = h('select.select', bots.map((b) => h('option', { value: b.id, selected: b.id === pick }, b.name)));
  sel.addEventListener('change', () => (pick = sel.value));
  const goal = h('textarea.textarea', { rows: 3, placeholder: 'e.g. Get 30 qualified ranch leads into a sheet and email each of them a personal intro over the next week' });
  const done = h('input.input', { placeholder: 'e.g. 30 leads in the sheet, all emailed, replies logged' });
  const hours = h('select.select', [['any', 'Any time, day or night'], ['weekdays 9-18', 'Weekdays, 9 to 6'], ['daily 8-22', 'Every day, 8 to 10']].map(([v, l]) => h('option', { value: v }, l)));
  const budget = h('input.input', { type: 'number', min: 1, max: 200, value: 12 });
  modal({ title: 'Start a mission', wide: true, body: [
    h('p.hint', { style: { margin: 0 } }, 'A mission is work a Bot owns until it’s done: it plans, works in sessions, waits on people like a person would, and checks back on its own, for as long as it takes. Your ' + host.machine + ' needs to be on for it to work.'),
    h('div.field', h('label', 'Bot'), sel),
    h('div.field', h('label', 'Goal'), goal),
    h('div.field', h('label', 'Done when'), done, h('div.hint', 'Optional. The Bot writes checkable criteria if you leave it empty.')),
    h('div.hstack', { style: { alignItems: 'flex-start', flexWrap: 'wrap' } },
      h('div.field', { style: { flex: 2, minWidth: '200px' } }, h('label', 'Working hours'), hours),
      h('div.field', { style: { flex: 1, minWidth: '120px' } }, h('label', 'Sessions a day, at most'), budget)),
  ], actions: [{ label: 'Cancel' }, { label: 'Start mission', primary: true, onClick: async () => {
    if (!goal.value.trim()) { toast('Describe the goal', 'bad'); return false; }
    try {
      const m = await api('POST', '/api/missions', { botId: pick, title: goal.value.trim().split(/[.\n]/)[0].slice(0, 80), goal: goal.value.trim(), doneWhen: done.value.trim(), hours: hours.value, dailyBudget: Number(budget.value) || 12 });
      toast(`${bot(pick)?.name} is on it`);
      go(`#/chat/${m.chat_id}`);
    } catch (e) { toast(e.message, 'bad'); return false; }
  } }] });
  setTimeout(() => goal.focus(), 30);
}

export function renderMissions($main) {
  const all = S.missions || [];
  const groups = [
    ['Needs you', all.filter((m) => m.status === 'blocked')],
    ['In progress', all.filter((m) => ['active', 'waiting'].includes(m.status))],
    ['Paused', all.filter((m) => m.status === 'paused')],
    ['Finished', all.filter((m) => ['done', 'stopped'].includes(m.status))],
  ].filter(([, l]) => l.length);
  $main.replaceChildren(h('div.page', h('div.page-in',
    h('div.hstack', { style: { justifyContent: 'space-between', flexWrap: 'wrap' } },
      h('div', h('h1', 'Missions'), h('p.lede', { style: { margin: '4px 0 0' } }, 'Work your Bots own until it’s done, over hours or days.')),
      h('button.btn.primary', { style: { height: '34px' }, on: { click: () => newMission() } }, icon('plus'), 'Start a mission')),
    groups.length ? groups.map(([name, list]) => h('section', { style: { marginTop: '22px' } }, h('div.group-h', name), h('div.mission-grid', list.map((m) => missionCard(m)))))
      : h('div.calm', { style: { marginTop: '24px' } }, h('div.calm-ic', icon('sparkle')), h('div', h('b', 'No missions yet'), h('div.hint', 'Give a Bot something big, like a week of outreach or a research project. It plans, works in sessions and checks back on its own.'))))));
}

let openTimer;
on('mission', () => {
  if (S.route.name === 'missions') { clearTimeout(openTimer); openTimer = setTimeout(() => renderMissions(document.getElementById('main')), 150); }
});
