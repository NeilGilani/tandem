// Home: a greeting, ask any Bot, everything waiting on you, who's working right now
// (with live screens), your Bots, and what got done today.
import { api, h, avatar, icon, toast, menu, fileUrl } from './lib.js';
import { S, bot, chat, dmOf, runsIn, go, comp } from './store.js';

let askBot = null;
let $root = null;
let todayCache = { at: 0, items: [] };

const ago = (ts) => {
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' });
};
const dur = (ms) => { const s = Math.round(ms / 1000); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`; };

function greeting() {
  const hr = new Date().getHours();
  const part = hr < 5 ? 'Working late' : hr < 12 ? 'Good morning' : hr < 17 ? 'Good afternoon' : hr < 22 ? 'Good evening' : 'Working late';
  const first = (S.settings.user_name || '').split(/\s+/)[0];
  return first ? `${part}, ${first}` : part;
}

export async function renderHome($main, { renderCard, planBars }) {
  $root = $main;
  if (!askBot || !bot(askBot)) askBot = (S.bots.find((b) => b.is_primary) || S.bots[0])?.id;
  if (Date.now() - todayCache.at > 4000) {
    const d = new Date();
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    api('GET', `/api/activity?day=${day}`).then((r) => { todayCache = { at: Date.now(), items: r.items }; if ($root === $main && S.route.name === 'home') paint($main, renderCard, planBars); }).catch(() => {});
    todayCache.at = Date.now();
  }
  paint($main, renderCard, planBars);
}

function paint($main, renderCard, planBars) {
  const scroll = $main.querySelector('.home')?.scrollTop || 0;
  const working = S.runs.filter((r) => bot(r.botId));
  const pending = (S.pending || []).filter((m) => bot(m.bot_id));
  const items = todayCache.items;
  const runsDone = items.filter((i) => i.kind === 'run' && i.status === 'ok');
  const actions = items.filter((i) => i.kind === 'tool' && i.status === 'ok').length;
  const drafts = items.filter((i) => i.kind === 'draft').length;

  // Ask a Bot.
  const ab = bot(askBot);
  const ta = h('textarea', { rows: 1, placeholder: ab ? `Ask ${ab.name} to…` : 'Create a Bot to get started' });
  const autosize = () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 200) + 'px'; };
  ta.addEventListener('input', autosize);
  const send = async () => {
    const text = ta.value.trim();
    if (!text || !ab) return;
    const c = dmOf(ab.id);
    ta.value = '';
    await api('POST', `/api/chats/${c.id}/messages`, { text }).catch((e) => toast(e.message, 'bad'));
    go(`#/chat/${c.id}`);
  };
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } });
  const picker = ab && h('button.ask-who', { on: { click: (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    menu(r.left, r.bottom + 6, S.bots.map((b) => ({ label: b.name, onClick: () => { askBot = b.id; paint($main, renderCard, planBars); } })));
  } } }, avatar(ab, 22), ab.name, h('span.chev'));

  const section = (title, count, ...body) => h('section.home-sec', h('div.home-h', h('h2', title), count != null ? h('span.count', String(count)) : null), ...body);

  const pendingBlock = pending.length
    ? h('div.needs', pending.slice(0, 12).map((m) => {
      const b = bot(m.bot_id);
      return h('div.need', { 'data-id': m.id },
        h('div.need-h', avatar(b, 22), h('b', b.name), h('span.hint', ago(m.created)), h('button.btn.ghost.sm', { on: { click: () => go(`#/chat/${m.chat_id}`) } }, 'Open chat')),
        renderCard(m));
    }))
    : h('div.calm', h('div.calm-ic', icon('check')), h('div', h('b', 'Nothing needs you'), h('div.hint', 'Approvals, drafts and questions from your Bots show up here.')));

  const workingBlock = working.length
    ? h('div.live-grid', working.map((r) => {
      const b = bot(r.botId);
      const live = r.browser || comp(r.botId).running;
      const img = h('img', { alt: '', 'data-live': r.botId, hidden: true });
      return h('button.live', { on: { click: () => go(`#/chat/${r.chatId}`) } },
        live ? h('div.live-shot', img, h('div.live-dim')) : h('div.live-shot.blank', avatar(b, 54, { busy: true })),
        h('div.live-b', avatar(b, 26, { busy: true }), h('div.t', h('b', b.name), h('span.shimmer', r.status || 'Working')), h('span.hint', dur(Date.now() - r.started))));
    }))
    : h('div.calm', h('div.calm-ic', icon('sparkle')), h('div', h('b', 'All quiet'), h('div.hint', 'When a Bot starts working, you can watch it here.')));

  const botsBlock = h('div.bot-grid', S.bots.filter((b) => !b.hidden).map((b) => {
    const c = dmOf(b.id);
    const run = S.runs.find((r) => r.botId === b.id);
    const last = c && S.chats.find((x) => x.id === c.id)?.last;
    return h('button.bot-tile', { on: { click: () => c && go(`#/chat/${c.id}`) } },
      avatar(b, 44, { busy: !!run }),
      h('div.t', h('b', b.name), h('span', run ? run.status : last ? `${b.label || 'Ready'} · ${ago(last.created)}` : (b.label || 'Ready'))),
      run ? h('span.pill.warn.spin', { title: 'Working' }) : null);
  }), h('button.bot-tile.add', { on: { click: () => window.tandemNewBot?.() } }, h('span.plus', icon('plus')), h('div.t', h('b', 'New Bot'), h('span', 'Give it a job'))));

  const todayBlock = h('div.today',
    h('div.stats',
      h('div.stat', h('b', String(runsDone.length)), h('span', 'tasks finished')),
      h('div.stat', h('b', String(actions)), h('span', 'actions taken')),
      h('div.stat', h('b', String(drafts)), h('span', 'drafts written')),
      h('div.stat', h('b', String(pending.length)), h('span', 'waiting on you'))),
    runsDone.length ? h('div.list', runsDone.slice(0, 6).map((i) => {
      const b = bot(i.bot_id);
      return h('button.list-row', { style: { width: '100%', border: 0, background: 'none', textAlign: 'left', cursor: 'pointer' }, on: { click: () => i.chat_id && go(`#/chat/${i.chat_id}`) } },
        avatar(b, 24), h('div.grow', (i.detail || i.summary).split('\n')[0].slice(0, 140), h('small', `${b?.name || 'Bot'} · ${new Date(i.created).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`)));
    })) : null,
    h('button.btn.ghost', { style: { justifySelf: 'start' }, on: { click: () => go('#/activity') } }, 'See all activity'));

  const plan = S.settings.plan;
  $main.replaceChildren(h('div.page.home',
    h('div.home-in',
      h('header.home-top', h('div', h('h1', greeting()), h('p.hint', new Date().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' }))),
        plan ? h('button.plan-mini', { title: 'Claude plan usage', on: { click: () => go('#/settings/usage') } }, planBars(plan, { compact: true })) : null),
      ab ? h('div.ask', picker, h('div.ask-row', ta, h('button.round.dark', { title: 'Send', on: { click: send } }, icon('up')))) : null,
      section('Needs you', pending.length || null, pendingBlock),
      section('Working now', working.length || null, workingBlock),
      section('Your Bots', null, botsBlock),
      section('Today', null, todayBlock))));
  $main.querySelector('.home').scrollTop = scroll;
}

export function refreshHome(deps, { refetch = false } = {}) {
  if (!$root || S.route.name !== 'home' || !$root.querySelector('.home')) return;
  if (refetch) { todayCache.at = 0; return renderHome($root, deps); }
  paint($root, deps.renderCard, deps.planBars);
}
