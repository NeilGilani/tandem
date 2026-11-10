// The office floor: every Bot at its desk with its laptop's screen and what it's doing,
// the meeting room when a meeting is on, the channels' chatter, and the goals scoreboard.
import { api, h, avatar, icon, md, toast } from './lib.js';
import { S, bot, dmOf, go, on, toggleComputer } from './store.js';

let data = null;
const fmtH = (n) => (n === 12 ? '12 pm' : n > 12 ? `${n - 12} pm` : `${n} am`);

function presence(b, company) {
  const run = S.runs.find((r) => r.botId === b.id && !r.squadId);
  const meeting = (data?.meetings || []).find((m) => m.status === 'running' && m.attendees.includes(b.id));
  if (meeting) return { cls: 'meeting', line: `In ${meeting.title}` };
  if (run) return { cls: 'working', line: run.status || 'Working' };
  if ((S.pending || []).some((m) => m.bot_id === b.id && m.card?.type !== 'draft')) return { cls: 'blocked', line: 'Waiting on you' };
  const sh = (company?.shifts || []).find((x) => x.botId === b.id);
  const m = String(sh?.hours || '').match(/(\d{1,2})-(\d{1,2})/);
  const hr = new Date().getHours(), wd = ![0, 6].includes(new Date().getDay());
  if (m && hr >= +m[1] && hr < +m[2] && (wd || /daily/.test(sh.hours))) return { cls: 'idle', line: 'At desk' };
  return { cls: 'away', line: m ? `Off shift, in at ${fmtH(+m[1])}` : 'Not scheduled' };
}

export async function renderOffice($main) {
  let company;
  try { [data, company] = await Promise.all([api('GET', '/api/office'), api('GET', '/api/company')]); }
  catch (e) { $main.replaceChildren(h('div.page', h('p.hint', e.message))); return; }
  const titles = Object.fromEntries(company.org.map((o) => [o.id, o.title]));

  const desks = h('div.floor', S.bots.map((b) => {
    const p = presence(b, company);
    const live = p.cls === 'working';
    const img = h('img', { alt: '', hidden: true });
    if (live) img.dataset.live = b.id;
    return h(`button.desk.d-${p.cls}`, { title: `Watch ${b.name}'s screen`, on: { click: () => { S.focusBot = b.id; toggleComputer(true); } } },
      h('div.monitor', img, !live && h('div.monitor-off', p.cls === 'away' ? icon('monitor') : p.cls === 'meeting' ? icon('users') : null)),
      h('div.desk-who', avatar(b, 24, { busy: live }), h('div', h('b', b.name), h('span', titles[b.id] || b.label || '')), h('i.desk-dot')),
      h('div.desk-line', p.line));
  }));

  const now = data.meetings.find((m) => m.status === 'running');
  const next = data.meetings.filter((m) => m.next_run).sort((a, b) => a.next_run - b.next_run)[0];
  const room = now
    ? h('div.mroom.on', h('div.mroom-h', icon('users'), h('b', now.title), h('span.live-pill', 'In session')),
      h('div.mroom-people', now.attendees.map((id) => avatar(bot(id), 26))),
      h('div.mroom-actions', h('button.btn.sm.primary', { on: { click: () => go(`#/chat/${now.chat_id}`) } }, 'Join the room')))
    : h('div.mroom', h('div.mroom-h', icon('users'), h('b', 'Meeting room'), h('span.hint', 'Empty')),
      next ? h('div.hint', `Next: ${next.title}, ${new Date(next.next_run).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`) : h('div.hint', 'No meetings scheduled yet. Set them up on the Company page.'),
      next && h('div.mroom-actions', h('button.btn.sm', { on: { click: () => api('POST', `/api/office/meetings/${next.id}/run`).then(() => toast(`${next.title} is starting`)) } }, 'Start it now')));

  const chatter = data.channels.length ? h('div.chatter', data.channels.map((c) => h('button.chan', { on: { click: () => go(`#/chat/${c.id}`) } },
    h('div.chan-h', h('b', c.name), h('span', `${c.members.length} people`)),
    h('div.chan-last', (c.last || 'No messages yet').split('\n').slice(-3).map((l) => h('div', l.slice(0, 140)))))))
    : h('p.hint', 'Channels appear once your team has bosses and reports.');

  const goals = data.goals.length ? h('div.score', data.goals.slice(0, 8).map((g) => {
    const pct = Math.min(100, Math.round((g.current / g.target) * 100));
    return h('div.goal', h('div.goal-h', h('span', g.title), h('em', `${g.current} of ${g.target}${g.unit ? ` ${g.unit}` : ''}`)), h('div.goal-bar', h('i', { style: { width: `${pct}%` } })),
      h('div.goal-m', g.owner_id ? bot(g.owner_id)?.name : 'Company', g.due && ` · due ${g.due}`));
  })) : h('p.hint', 'No goals yet. Add them on the Company page.');

  const working = S.runs.filter((r) => !r.squadId).length;
  $main.replaceChildren(h('div.page.office', h('div.page-in',
    h('div.co-head', h('div', h('h1', S.settings.company_name || 'Office'), h('p.lede', `${working} working right now · ${S.bots.length} on the team`)),
      h('button.btn', { on: { click: () => go('#/company') } }, icon('users'), 'Org and work board')),
    h('div.office-grid',
      h('section', h('div.group-h', 'The floor'), desks),
      h('aside', h('div.group-h', 'Meeting room'), room, h('div.group-h', 'Channels'), chatter, h('div.group-h', 'Goals'), goals)))));
}

let t;
for (const evt of ['run', 'company']) on(evt, () => { if (S.route.name === 'office') { clearTimeout(t); t = setTimeout(() => renderOffice(document.getElementById('main')), 800); } });
