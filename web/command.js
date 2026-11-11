// Home: one line to the whole company. Say what you want; decisions come back as one-tap
// cards; finished work shows up as one line each. Bot chats are there if you want them.
import { api, h, avatar, icon, toast, md, modal } from './lib.js';
import { S, bot, dmOf, go, on } from './store.js';
import { openInboxAt } from './inbox.js';

let feed = { working: [], done: [], brief: null };
const me = () => (S.me?.owner === false ? S.me.name : S.settings.user_name) || '';
let $root = null;
let briefOpen = false;
let $box = null;
const ago = (t) => { const m = Math.round((Date.now() - t) / 60000); return m < 1 ? 'now' : m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`; };
const card = (m, payload) => api('POST', `/api/cards/${m.id}`, payload).catch((e) => toast(e.message, 'bad'));

export async function renderCommand($main) {
  if ($root !== $main) $box = null;
  $root = $main;
  try { feed = await api('GET', '/api/command/feed'); } catch {}
  draw();
}

function draw() {
  if (!$root || S.route.name !== 'home' || S.route.id || !$root.isConnected) return;
  const calls = decisions();
  const hour = new Date().getHours();
  const hello = `${hour < 12 ? 'Morning' : hour < 18 ? 'Afternoon' : 'Evening'}${me() ? `, ${me().split(' ')[0]}` : ''}`;
  $root.replaceChildren(h('div.page.cx', h('div.page-in',
    h('div.cx-hello', h('h1', hello), h('span.hint', S.bots.length ? `${S.runs.filter((r) => !r.squadId).length} working · ${S.bots.length} on the team` : ''), h('a.hint.cx-dash', { href: '#/home/board' }, 'Full dashboard')),
    ($box ||= askBox()),
    feed.brief && h('div.cx-brief', h('button.cx-brief-h', { on: { click: () => { briefOpen = !briefOpen; draw(); } } }, icon('sparkle'), h('b', 'Morning brief'), h('span.hint', `${feed.brief.bot} · ${ago(feed.brief.at) === 'now' ? 'just now' : `${ago(feed.brief.at)} ago`}`), h('span.cx-brief-t', briefOpen ? 'Hide' : 'Read')),
      briefOpen && h('div.md.cx-brief-b', { html: md(feed.brief.text) })),
    h('div.cx-cols',
      h('section.cx-decide', h('div.cx-h', icon('hand'), 'Needs your call', calls.length ? h('span.cx-n', String(calls.length)) : null),
        calls.length ? calls : h('div.cx-empty', 'Nothing needs you. Your team is handling it.'),
        waitingOn()),
      h('section.cx-results',
        feed.working.length > 0 && [h('div.cx-h', icon('activity'), 'In progress'), h('div.cx-rows', feed.working.map(workRow))],
        h('div.cx-h', icon('check'), 'Done today'),
        feed.done.length ? h('div.cx-rows', feed.done.map(doneRow)) : h('div.cx-empty', 'Finished work shows up here, one line each.'))))));
}

// ---- The box ---------------------------------------------------------------------------
function askBox() {
  const ta = h('textarea', { rows: 1, placeholder: S.bots.length ? 'Tell your team what you want done' : 'Create a Bot first', disabled: !S.bots.length });
  const grow = () => { ta.style.height = 'auto'; ta.style.height = `${Math.min(ta.scrollHeight, 180)}px`; };
  const send = async () => {
    const text = ta.value.trim();
    if (!text) return;
    ta.value = ''; grow();
    try {
      const r = await api('POST', '/api/command', { text });
      feed.working.unshift({ kind: 'task', id: r.id, title: r.title, botId: r.ownerId, bot: r.owner, line: 'Starting', live: true });
      toast(`${r.owner} is on it`);
      draw();
    } catch (e) { toast(e.message, 'bad'); ta.value = text; }
  };
  ta.addEventListener('input', grow);
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } });
  let rec = null;
  const mic = h('button.cx-mic', { title: 'Say it', on: { click: () => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return toast('Dictation isn\'t available here', 'bad');
    if (rec) { rec.stop(); return; }
    rec = new SR(); rec.interimResults = true; rec.continuous = false;
    const base = ta.value;
    rec.onresult = (e) => { ta.value = `${base}${base ? ' ' : ''}${[...e.results].map((r) => r[0].transcript).join('')}`; grow(); };
    rec.onend = () => { rec = null; mic.classList.remove('on'); if (ta.value.trim()) send(); };
    mic.classList.add('on'); rec.start();
  } } }, icon('mic'));
  setTimeout(() => ta.focus(), 30);
  return h('div.cx-box', icon('sparkle'), ta, mic, h('button.cx-go', { title: 'Send', on: { click: send } }, icon('up')));
}

// ---- Decisions: one question, a few taps ----------------------------------------------
// Cards are for whoever asked: the owner gets theirs plus anything unassigned; a teammate gets theirs.
const mine = (m) => { const f = m.card.for || 'user'; return S.me?.owner ? f === 'user' || !personName(f) : f === S.me?.id; };
const personName = (id) => (id === 'user' ? S.settings.user_name : (S.members || []).find((x) => x.id === id)?.name);
const forOthers = () => (S.pending || []).filter((m) => bot(m.bot_id) && !mine(m));

function decisions() {
  const items = (S.pending || []).filter((m) => bot(m.bot_id) && mine(m));
  const out = [];
  const drafts = items.filter((m) => m.card.type === 'draft');
  const byBot = new Map();
  for (const d of drafts) (byBot.get(d.bot_id) || byBot.set(d.bot_id, []).get(d.bot_id)).push(d);
  for (const [botId, list] of byBot) {
    const many = list.length > 1;
    out.push(dcard(botId, many ? `Send these ${list.length} emails?` : `Send to ${list[0].card.to}?`,
      many ? list.map((d) => d.card.to).slice(0, 5).join(', ') + (list.length > 5 ? ` and ${list.length - 5} more` : '') : list[0].card.subject || list[0].card.body.slice(0, 90),
      [[many ? `Send all ${list.length}` : 'Send', true, async () => { for (const d of list) await card(d, { action: 'send' }); toast(many ? `Sending ${list.length}` : 'Sending'); }],
        ['Review', false, () => openInboxAt(list[0].id)],
        [many ? 'Skip all' : 'Skip', false, async () => { for (const d of list) await card(d, { action: 'discard' }); }]]));
  }
  for (const m of items.filter((x) => x.card.type !== 'draft')) {
    const c = m.card;
    if (c.type === 'approval') out.push(dcard(m.bot_id, `${c.summary}?`, c.warnings?.[0] || c.site || '', [['Allow', true, () => card(m, { choice: 'allow' })], ['Deny', false, () => card(m, { choice: 'deny' })]]));
    else if (c.type === 'question') {
      if (c.options?.length) out.push(dcard(m.bot_id, plain(c.question), '', c.options.slice(0, 4).map((o, i) => [o, i === 0, () => card(m, { answer: o })])));
      else {
        const inp = h('input.input', { placeholder: 'Your answer', on: { keydown: (e) => { if (e.key === 'Enter' && inp.value.trim()) card(m, { answer: inp.value.trim() }); } } });
        out.push(dcard(m.bot_id, plain(c.question), '', [['Send', true, () => inp.value.trim() && card(m, { answer: inp.value.trim() })]], inp));
      }
    } else if (c.type === 'hire') out.push(dcard(m.bot_id, `Hire a ${c.role}?`, plain(c.why || ''), [['Hire', true, () => card(m, {})], ['No', false, () => card(m, { decline: true })]]));
    else {
      const what = { gmail_connect: 'Connect Gmail for the team', connect: `Connect ${c.name}`, secret: c.title || 'Save a login', takeover: plain(c.reason || 'Help with one step'), skill_draft: `Save skill: ${c.title}` }[c.type] || 'Needs you';
      out.push(dcard(m.bot_id, what, '', [['Open', true, () => openInboxAt(m.id)]]));
    }
  }
  return out;
}
const plain = (s) => String(s || '').replace(/[*_`#>]/g, '').split('\n').filter(Boolean)[0]?.slice(0, 160) || '';

function dcard(botId, q, sub, buttons, extra) {
  const b = bot(botId);
  return h('div.cx-card',
    h('div.cx-card-who', avatar(b, 18), h('span', b?.name || 'A Bot')),
    h('div.cx-card-q', q), sub && h('div.cx-card-sub', sub), extra || null,
    h('div.cx-card-btns', buttons.map(([label, primary, fn]) => h(`button.btn.sm${primary ? '.primary' : ''}`, { on: { click: async (e) => { e.currentTarget.disabled = true; await fn(); } } }, label))));
}

// Teammates' open questions, so you can see what's held up on them.
function waitingOn() {
  const counts = new Map();
  for (const m of forOthers()) { const n = (personName(m.card.for || 'user') || 'someone').split(' ')[0]; counts.set(n, (counts.get(n) || 0) + 1); }
  if (!counts.size) return null;
  return h('div.cx-wait', [...counts].map(([n, c]) => `${c} waiting on ${n}`).join(' · '));
}
// "for Sam" on requests someone else made.
const by = (id) => { if (!id) return ''; const me = S.me?.owner ? 'user' : S.me?.id; return id === me ? '' : ` · for ${(personName(id) || 'a teammate').split(' ')[0]}`; };

// ---- Results --------------------------------------------------------------------------
function workRow(w) {
  const r = S.runs.find((x) => x.botId === w.botId && !x.squadId);
  if (r) { w.live = true; w.line = r.status || w.line; }
  return h('button.cx-row', { on: { click: () => go(`#/chat/${dmOf(w.botId)?.id}`) } },
    h(`span.cx-ic${w.live ? '.live' : ''}`, w.live ? icon('refresh') : icon(w.kind === 'mission' ? 'target' : 'activity')),
    h('div.cx-t', h('b', w.title), h('span', `${w.bot}${by(w.by)} · ${w.line}`)));
}
function doneRow(d) {
  return h('button.cx-row', { on: { click: () => details(d) } },
    h('span.cx-ic.done', icon(d.kind === 'sent' ? 'send' : 'check')),
    h('div.cx-t', h('b', d.title), d.result && h('span.cx-r', d.result), h('span', `${d.bot}${by(d.by)} · ${ago(d.at) === 'now' ? 'just now' : `${ago(d.at)} ago`}`)));
}
function details(d) {
  modal({ title: d.title, body: [h('div', d.result || ''), h('div.hint', `${d.bot} · ${new Date(d.at).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`)],
    actions: [{ label: `Open chat with ${d.bot}`, onClick: () => go(`#/chat/${dmOf(d.botId)?.id}`) }, { label: 'Close', primary: true }] });
}

let tFetch, tDraw;
const soon = (refetch) => {
  if (refetch) { clearTimeout(tFetch); tFetch = setTimeout(() => renderCommand($root), 600); }
  else { clearTimeout(tDraw); tDraw = setTimeout(draw, 50); }
};
on('message', (m) => { if (S.route.name === 'home' && !S.route.id && m.card) soon(false); });
on('company', () => { if (S.route.name === 'home' && !S.route.id) soon(true); });
let lastDraw = 0;
on('run', (r) => {
  if (S.route.name !== 'home' || S.route.id) return;
  if (r.ended) return soon(true);
  if (Date.now() - lastDraw > 1500) { lastDraw = Date.now(); soon(false); }
});
