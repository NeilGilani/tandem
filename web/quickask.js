// Quick Ask: a Spotlight-style box to hand any Bot a task in seconds.
// ⌘J in the app; ⌥Space anywhere on your Mac in the Mac app.
import { api, h, avatar, toast } from './lib.js';
import { S, bot, dmOf, go, warmChat } from './store.js';

let open = null;
const lastKey = 'tandem.qa.bot';

export function openQuickAsk({ onSent } = {}) {
  if (open) { open.ta.focus(); return; }
  const bots = S.bots.filter((b) => !b.hidden);
  if (!bots.length) return toast('Create a Bot first', 'bad');
  let pick = (() => { try { return localStorage.getItem(lastKey); } catch { return null; } })();
  if (!bot(pick)) pick = (bots.find((b) => b.is_primary) || bots[0]).id;

  const ta = h('textarea', { rows: 1, placeholder: 'Ask a Bot to do something' });
  const face = h('span');
  const row = h('div.qa-bots');
  const drawBots = () => {
    const b = bot(pick);
    face.replaceChildren(avatar(b, 34, { busy: false }));
    ta.placeholder = `Ask ${b.name} to…`;
    row.replaceChildren(...bots.map((x) => h(`button.qa-bot${x.id === pick ? '.on' : ''}`, { on: { click: () => { pick = x.id; drawBots(); ta.focus(); } } }, avatar(x, 22), x.name)));
    row.querySelector('.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  };
  const autosize = () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 220) + 'px'; };
  const close = () => { bg.remove(); open = null; };
  const send = async (stay) => {
    const text = ta.value.trim();
    if (!text) return;
    const c = dmOf(pick);
    try { localStorage.setItem(lastKey, pick); } catch {}
    close();
    onSent?.(c.id);
    try { await api('POST', `/api/chats/${c.id}/messages`, { text }); } catch (e) { return toast(e.message, 'bad'); }
    if (stay) toast(`Sent to ${bot(pick).name}`); else go(`#/chat/${c.id}`);
  };
  ta.addEventListener('input', () => { autosize(); warmChat(dmOf(pick)?.id, ta.value); });
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(e.metaKey || e.ctrlKey); }
    else if (e.key === 'Tab') {
      e.preventDefault();
      const i = bots.findIndex((b) => b.id === pick);
      pick = bots[(i + (e.shiftKey ? -1 : 1) + bots.length) % bots.length].id;
      drawBots();
    }
  });
  const box = h('div.qa', h('div.qa-top', face, ta), row,
    h('div.qa-foot', h('span', h('kbd', 'Enter'), 'Send and open'), h('span', h('kbd', '⌘Enter'), 'Send in the background'), h('span', h('kbd', 'Tab'), 'Switch Bot'), h('span', h('kbd', 'Esc'), 'Close')));
  const bg = h('div.qa-bg', { on: { mousedown: (e) => { if (e.target === bg) close(); } } }, box);
  document.body.append(bg);
  open = { ta };
  drawBots();
  setTimeout(() => ta.focus(), 20);
}

window.tandemQuickAsk = () => openQuickAsk();
