// Needs you: everything waiting on you across all Bots. Compact rows with one-click
// actions on Home, and a focused triage view (#/inbox) with keyboard shortcuts that
// moves to the next item on its own.
import { api, h, avatar, icon, toast, confirm } from './lib.js';
import { S, bot, go, on } from './store.js';

const KIND = {
  draft: { ic: 'mail', label: 'Draft' },
  approval: { ic: 'lock', label: 'Approval' },
  question: { ic: 'help', label: 'Question' },
  secret: { ic: 'key', label: 'Login' },
  connect: { ic: 'plug', label: 'Connect' },
  takeover: { ic: 'hand', label: 'Take over' },
  skill_draft: { ic: 'book', label: 'Skill' },
  hire: { ic: 'users', label: 'Hire' },
};
const ago = (ts) => {
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
};

export function titleOf(m) {
  const c = m.card;
  switch (c.type) {
    case 'draft': return c.subject || `To ${c.to}`;
    case 'approval': return c.summary;
    case 'question': return String(c.question || '').replace(/[*_`#>]/g, '').split('\n')[0];
    case 'secret': return c.title || `Save ${c.name}`;
    case 'connect': return `Connect ${c.name}`;
    case 'takeover': return c.reason;
    case 'skill_draft': return c.title;
    case 'hire': return c.title;
    default: return 'Needs you';
  }
}
function subOf(m) {
  const c = m.card, b = bot(m.bot_id);
  const bits = [b?.name || 'Bot'];
  if (c.type === 'draft') bits.push(`${c.app || 'Email'} to ${c.to}${c.reviewedBy ? `, reviewed by ${c.reviewedBy}` : ''}`);
  else if (c.type === 'approval' && c.site) bits.push(c.site);
  else bits.push(KIND[c.type]?.label);
  return bits.filter(Boolean).join(' · ');
}

const act = (m, payload) => api('POST', `/api/cards/${m.id}`, payload).catch((e) => toast(e.message, 'bad'));

// The quick actions for one item: the safe, obvious ones only.
function quick(m, { onOpen }) {
  const c = m.card;
  const b = (label, cls, fn) => h(`button.btn.sm${cls}`, { on: { click: (e) => { e.stopPropagation(); fn(); } } }, label);
  switch (c.type) {
    case 'draft': return [b('Send', '.primary', () => act(m, { action: 'send' })), b('Discard', '.ghost', () => act(m, { action: 'discard' }))];
    case 'approval': return [b('Allow', '.primary', () => act(m, { choice: 'allow' })), b('Deny', '.ghost', () => act(m, { choice: 'deny' }))];
    case 'connect': return [b('Sign in', '.primary', () => act(m, {})), b('Not now', '.ghost', () => act(m, { dismiss: true }))];
    case 'takeover': return [b("I'm done", '.primary', () => act(m, {}))];
    default: return [b('Open', '', onOpen)];
  }
}

export function inboxRows(items, { max = 6, onOpen } = {}) {
  const shown = items.slice(0, max);
  return h('div.inbox-list', shown.map((m) => {
    const k = KIND[m.card.type] || { ic: 'sparkle' };
    return h('div.inbox-row', { 'data-id': m.id, on: { click: () => onOpen(m) } },
      h('span.ib-ic', icon(k.ic)),
      avatar(bot(m.bot_id), 26),
      h('div.ib-t', h('b', titleOf(m)), h('span', subOf(m))),
      h('span.ib-time', ago(m.created)),
      h('div.ib-act', quick(m, { onOpen: () => onOpen(m) })));
  }));
}

// ---------- Triage view -----------------------------------------------------------------
let sel = null;
export function openInboxAt(id) { sel = id; go('#/inbox'); }
let $root = null, deps = null;

export function renderInbox($main, d) {
  $root = $main; deps = d;
  const items = S.pending || [];
  if (!items.find((m) => m.id === sel)) sel = items[0]?.id || null;
  const cur = items.find((m) => m.id === sel);

  if (!items.length) {
    $main.replaceChildren(h('div.page', h('div.inbox-zero',
      h('div.iz-faces', S.bots.slice(0, 5).map((b, i) => { const a = avatar(b, 52); a.classList.add('happy'); a.style.animationDelay = `${i * 0.08}s`; return a; })),
      h('h1', 'Inbox zero'),
      h('p', 'Nothing is waiting on you. Your Bots will bring you anything they need.'),
      h('button.btn', { on: { click: () => go('#/home') } }, 'Back to Home'))));
    return;
  }

  const drafts = items.filter((m) => m.card.type === 'draft');
  const list = h('div.tri-list', items.map((m) => {
    const k = KIND[m.card.type] || { ic: 'sparkle' };
    return h(`button.tri-item${m.id === sel ? '.on' : ''}`, { 'data-id': m.id, on: { click: () => { sel = m.id; renderInbox($root, deps); } } },
      h('span.ib-ic', icon(k.ic)), avatar(bot(m.bot_id), 22),
      h('div.ib-t', h('b', titleOf(m)), h('span', subOf(m))), h('span.ib-time', ago(m.created)));
  }));
  const b = bot(cur.bot_id);
  const detail = h('div.tri-detail',
    h('div.tri-head', avatar(b, 34), h('div', h('b', b?.name), h('span.hint', `${KIND[cur.card.type]?.label || ''} · ${new Date(cur.created).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`)),
      h('button.btn.ghost.sm', { style: { marginLeft: 'auto' }, on: { click: () => go(`#/chat/${cur.chat_id}`) } }, 'Open chat')),
    h('div.tri-card', deps.renderCard(cur)),
    h('div.tri-keys', h('span', h('kbd', 'J'), h('kbd', 'K'), 'Next, previous'), h('span', h('kbd', '⌘'), h('kbd', 'Enter'), primaryLabel(cur)), h('span', h('kbd', '⌫'), secondaryLabel(cur))));

  $main.replaceChildren(h('div.page.tri',
    h('div.tri-top', h('h1', 'Needs you'), h('span.count', `${items.length} left`), h('span', { style: { flex: 1 } }),
      drafts.length > 1 && h('button.btn.sm', { on: { click: async () => {
        if (!await confirm(`Send all ${drafts.length} drafts as written? Each Bot sends its own.`, { label: `Send ${drafts.length}`, danger: false })) return;
        for (const m of drafts) { await act(m, { action: 'send' }); await new Promise((r) => setTimeout(r, 250)); }
        toast(`Sending ${drafts.length} drafts`);
      } } }, icon('send'), `Send all ${drafts.length} drafts`),
      h('button.btn.ghost.sm', { on: { click: () => go('#/home') } }, 'Done')),
    h('div.tri-body', list, detail)));
  $main.querySelector('.tri-item.on')?.scrollIntoView({ block: 'nearest' });
}

const primaryLabel = (m) => ({ draft: 'Send', approval: 'Allow', connect: 'Sign in', takeover: "I'm done" }[m.card.type] || 'Submit');
const secondaryLabel = (m) => ({ draft: 'Discard', approval: 'Deny', connect: 'Not now', secret: 'Not now', skill_draft: 'Discard' }[m.card.type] || 'Skip');

function move(d) {
  const items = S.pending || [];
  const i = items.findIndex((m) => m.id === sel);
  const n = items[Math.min(Math.max(i + d, 0), items.length - 1)];
  if (n) { sel = n.id; renderInbox($root, deps); }
}

async function primary() {
  const m = (S.pending || []).find((x) => x.id === sel);
  if (!m) return;
  const c = m.card;
  if (c.type === 'draft') {
    // Send exactly what's on screen, including any edits.
    const edits = {};
    const keys = { To: 'to', Cc: 'cc', Subject: 'subject' };
    for (const f of $root.querySelectorAll('.tri-card .draft-field')) {
      const k = keys[f.querySelector('label')?.textContent];
      if (k) edits[k] = f.querySelector('input').value;
    }
    const body = $root.querySelector('.tri-card textarea.draft-body');
    if (body) edits.body = body.value;
    return act(m, { action: 'send', edits });
  }
  if (c.type === 'approval') return act(m, { choice: 'allow' });
  if (c.type === 'connect') return act(m, {});
  if (c.type === 'takeover') return act(m, {});
  $root.querySelector('.tri-card .btn.primary')?.click();
}
async function secondary() {
  const m = (S.pending || []).find((x) => x.id === sel);
  if (!m) return;
  const t = m.card.type;
  if (t === 'draft' || t === 'skill_draft') return act(m, { action: 'discard' });
  if (t === 'approval') return act(m, { choice: 'deny' });
  if (t === 'connect' || t === 'secret') return act(m, { dismiss: true });
  move(1);
}

document.addEventListener('keydown', (e) => {
  if (S.route.name !== 'inbox' || document.querySelector('.modal-bg, .qa-bg')) return;
  const typing = e.target.closest?.('input, textarea, [contenteditable]');
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); primary(); return; }
  if (typing) return;
  if (e.key === 'j' || e.key === 'ArrowDown') { e.preventDefault(); move(1); }
  else if (e.key === 'k' || e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
  else if (e.key === 'Backspace' || e.key === 'Delete') { e.preventDefault(); secondary(); }
  else if (e.key === 'Escape') go('#/home');
});

// When an item is handled, stay on the same position (which is now the next item).
on('message', (m) => {
  if (S.route.name !== 'inbox' || !$root || !m.card) return;
  if (m.id === sel && m.card.status !== 'pending') {
    const items = S.pending || [];
    sel = items[0] ? (items.find((x) => x.created <= m.created) || items[0]).id : null;
  }
  setTimeout(() => S.route.name === 'inbox' && renderInbox($root, deps), 30);
});
