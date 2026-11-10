// First-run setup: checks Claude Code, asks your name, creates your first Bots,
// connects your email on your primary Bot's computer, and hands it a real first task.
import { api, h, avatar, icon, toast, logo } from './lib.js';
import { S, refresh, go, comp, on } from './store.js';

let step = 0;
const st = { name: '', picks: new Set(['chief-of-staff', 'inbox-manager']), email: null, created: [], primary: null, chatId: null, connectorId: null };

const shell = (...kids) => h('div', { style: { flex: 1, overflowY: 'auto', display: 'grid', placeItems: 'center', padding: '40px 20px' } },
  h('div', { style: { width: 'min(560px, 100%)', display: 'grid', gap: '18px' } },
    h('div.hstack', { style: { gap: '6px' } }, [0, 1, 2, 3, 4].map((i) => h('span', { style: { height: '4px', flex: 1, borderRadius: '99px', background: i <= step ? 'var(--text)' : 'var(--line)' } }))),
    ...kids));
const title = (t, sub) => [h('h1', { style: { fontSize: '26px', fontWeight: 600, letterSpacing: '-.02em', margin: '6px 0 0' } }, t), sub && h('p', { style: { color: 'var(--text-2)', margin: 0, fontSize: '15px' } }, sub)];
const nav = (back, nextLabel, onNext, { disabled = false, skip } = {}) => h('div.hstack', { style: { marginTop: '8px' } },
  back ? h('button.btn.ghost', { on: { click: () => { step--; render(); } } }, 'Back') : null,
  h('span', { style: { flex: 1 } }),
  skip ? h('button.btn.ghost', { on: { click: skip } }, 'Skip') : null,
  h('button.btn.primary', { disabled, style: { height: '36px', padding: '0 18px' }, on: { click: onNext } }, nextLabel));

let $main;
export function needsOnboarding() { return !S.settings.onboarded && S.bots.length === 0; }
export function renderOnboarding(main) { $main = main; render(); }

async function render() {
  if (step === 0) {
    const health = await api('GET', '/api/health').catch(() => null);
    const okClaude = health?.claude?.loggedIn;
    const okChrome = health?.chrome;
    const check = (ok, label, fix) => h('div.list-row', h('span.pill', { class: ok ? 'good' : 'bad' }, ok ? 'Ready' : 'Needed'), h('div.grow', label, !ok && h('small', fix)));
    $main.replaceChildren(shell(
      h('div', { style: { justifySelf: 'start' } }, avatar({ shape: 'circle', color: '#6d5dfc' }, 64, { blink: true })),
      ...title('Welcome to Tandem', 'Bots are AI coworkers. Each one gets its own computer, signs in to your apps and does real work, checking with you before anything goes out.'),
      h('div.list', check(okClaude, 'Claude Code, signed in', health?.claude?.installed ? 'Open Terminal and run: claude   then sign in, and come back.' : 'Install Claude Code from claude.com/claude-code, sign in, then come back.'),
        check(okChrome, 'Google Chrome (or Edge, Brave, Chromium)', 'Install Chrome. Each Bot uses its own copy of it.')),
      nav(false, okClaude && okChrome ? 'Get started' : 'Check again', () => { if (okClaude && okChrome) step = 1; render(); })));
    return;
  }
  if (step === 1) {
    const input = h('input.input', { value: st.name || S.settings.user_name || '', placeholder: 'Your name', style: { fontSize: '16px', padding: '10px 12px' } });
    $main.replaceChildren(shell(...title('What should your Bots call you?'), input,
      nav(true, 'Continue', async () => {
        st.name = input.value.trim();
        if (st.name) await api('PATCH', '/api/settings', { user_name: st.name });
        step = 2; render();
      })));
    setTimeout(() => input.focus(), 30);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') $main.querySelector('.btn.primary').click(); });
    return;
  }
  if (step === 2) {
    const templates = await api('GET', '/api/templates');
    const grid = h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: '8px' } });
    const draw = () => grid.replaceChildren(...templates.map((t) => {
      const on = st.picks.has(t.id);
      return h('button', { style: { display: 'flex', gap: '10px', alignItems: 'center', textAlign: 'left', padding: '10px 12px', borderRadius: '14px', border: `1.5px solid ${on ? 'var(--text)' : 'var(--line)'}`, background: on ? 'var(--hover)' : 'var(--bg)', color: 'var(--text)' },
        on: { click: () => { on ? st.picks.delete(t.id) : st.picks.add(t.id); draw(); } } },
      avatar(t, 34), h('div', h('div', { style: { fontWeight: 600, fontSize: '13.5px' } }, t.name), h('div.hint', t.label)));
    }));
    draw();
    $main.replaceChildren(shell(...title('Pick your first Bots', 'Start with two or three. You can add more any time, or make one from scratch.'), grid,
      nav(true, 'Create Bots', async (e) => {
        if (!st.picks.size) return toast('Pick at least one Bot', 'bad');
        e.target.disabled = true; e.target.textContent = 'Creating…';
        st.created = [];
        for (const id of ['chief-of-staff', ...[...st.picks].filter((x) => x !== 'chief-of-staff')]) {
          if (!st.picks.has(id)) continue;
          const r = await api('POST', `/api/templates/${id}/import`);
          st.created.push(r);
        }
        st.primary = st.created[0].bot; st.chatId = st.created[0].chat.id;
        await api('POST', `/api/bots/${st.primary.id}/primary`);
        await refresh();
        step = 3; render();
      })));
    return;
  }
  if (step === 3) {
    const waiting = st.connectorId && comp(st.primary.id).control === 'user';
    const pick = async (catalogId, name) => {
      const row = await api('POST', '/api/connectors', { catalogId });
      st.connectorId = row.id; st.email = name;
      await api('POST', `/api/connectors/${row.id}/signin`, { botId: st.primary.id });
      render();
    };
    const choice = (id, name, color) => h('button.file-card', { style: { width: '100%' }, on: { click: () => pick(id, name) } }, logo({ name, color }, 34), h('span.t', h('b', name), h('small', `Sign in on ${st.primary.name}'s computer`)), h('span.btn', 'Connect'));
    $main.replaceChildren(shell(...title('Connect your email', `${st.primary.name} works best with your inbox. A browser window opens on ${st.primary.name}'s computer: sign in there, then come back and press I'm done. Your password stays in that browser; Tandem never sees it.`),
      waiting
        ? h('div.card.wide', h('div.card-h', `Signing in to ${st.email}`, h('span.pill.warn', 'Waiting for you')),
          h('div.card-b', h('div', 'Finish signing in in the window that opened. If you don’t see it, press Show window.')),
          h('div.card-actions', h('button.btn.primary', { on: { click: async () => { await api('POST', '/api/computer/done', { botId: st.primary.id }); step = 4; render(); } } }, "I'm done"),
            h('button.btn', { on: { click: () => api('POST', '/api/computer/focus', { botId: st.primary.id }) } }, 'Show window')))
        : h('div', { style: { display: 'grid', gap: '8px' } }, choice('gmail', 'Gmail', '#ea4335'), choice('outlook', 'Outlook', '#0078d4')),
      nav(true, 'Continue', () => { step = 4; render(); }, { skip: () => { st.email = null; step = 4; render(); } })));
    return;
  }
  if (step === 4) {
    const task = st.email
      ? `Go through my ${st.email} inbox from the last two days. Tell me the 3 things that most need me, and draft replies to anything that just needs a quick yes.`
      : 'Introduce yourself in two sentences, then ask me three questions so you can learn how I work and what I want help with first.';
    const ta = h('textarea.textarea', { value: task, rows: 4, style: { fontSize: '15px' } });
    $main.replaceChildren(shell(...title(`Give ${st.primary.name} its first task`, 'A real task with a clear finish line works best. You can watch it work, and it asks before sending anything.'), ta,
      nav(true, 'Start', async () => {
        await api('PATCH', '/api/settings', { onboarded: true });
        await api('POST', `/api/chats/${st.chatId}/messages`, { text: ta.value.trim() || task });
        S.settings.onboarded = true;
        go(`#/chat/${st.chatId}`);
      })));
  }
}

on('computer', (c) => { if (step === 3 && st.primary && c.botId === st.primary.id && $main?.isConnected) render(); });
