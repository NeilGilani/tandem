// Bot details drawer: Details (profile, picture, notifications), Routines, Library, Memory.
import { api, h, avatar, icon, toast, modal, confirm, sw, time, ago, fileUrl, SHAPES, COLORS } from './lib.js';
import { S, bot, dmOf, on, refresh, go } from './store.js';

const $drawer = document.getElementById('drawer');
let openId = null, tab = 'details';

export function openBotDrawer(id, t = 'details') {
  openId = id; tab = t;
  $drawer.hidden = false;
  paint();
}
export function closeDrawer() { openId = null; $drawer.hidden = true; }
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$drawer.hidden && !document.querySelector('.modal-bg')) closeDrawer(); });

on('state', () => openId && paint());
on('routines', (d) => openId && (!d.botId || d.botId === openId) && tab === 'routines' && paint());
on('library', (d) => openId && d.botId === openId && tab === 'library' && paint());

async function paint() {
  const b = bot(openId);
  if (!b) return closeDrawer();
  const tabs = [['details', 'Details'], ['routines', 'Routines'], ['library', 'Library'], ['memory', 'Memory']];
  const body = h('div.drawer-b');
  $drawer.replaceChildren(
    h('div.drawer-h', avatar(b, 30), h('b', b.name), h('button.icon-btn', { on: { click: closeDrawer } }, icon('x'))),
    h('div', { style: { padding: '0 16px' } }, h('div.tabs', { style: { marginBottom: 0 } }, tabs.map(([k, l]) => h(`button${tab === k ? '.on' : ''}`, { on: { click: () => { tab = k; paint(); } } }, l)))),
    body);
  if (tab === 'details') body.append(...details(b));
  else if (tab === 'routines') body.append(...await routinesTab(b));
  else if (tab === 'library') body.append(...await libraryTab(b));
  else body.append(...await memoryTab(b));
}

function details(b) {
  const patch = (p) => api('PATCH', `/api/bots/${b.id}`, p).catch((e) => toast(e.message, 'bad'));
  const name = h('input.input', { value: b.name, on: { change: (e) => e.target.value.trim() && patch({ name: e.target.value.trim() }) } });
  const label = h('input.input', { value: b.label || '', placeholder: 'Add a label', on: { change: (e) => patch({ label: e.target.value.trim() }) } });
  let picTab = 'bot';
  const pic = h('div');
  const drawPic = () => {
    pic.replaceChildren(
      h('div.tabs', { style: { marginBottom: '10px' } }, [['bot', 'Bot'], ['upload', 'Upload']].map(([k, l]) => h(`button${picTab === k ? '.on' : ''}`, { on: { click: () => { picTab = k; drawPic(); } } }, l))),
      picTab === 'bot'
        ? h('div', { style: { display: 'grid', gap: '10px' } },
          h('div.shape-pick', SHAPES.map((s) => h(`button${s === b.shape && !b.avatar ? '.on' : ''}`, { on: { click: () => patch({ shape: s, avatar: null }) } }, avatar({ ...b, shape: s, avatar: null }, 34)))),
          h('div.color-pick', COLORS.map((c) => h(`button${c === b.color ? '.on' : ''}`, { style: { background: c }, on: { click: () => patch({ color: c, avatar: null }) } }))))
        : h('div', { style: { display: 'grid', gap: '8px' } },
          h('input', { type: 'file', accept: 'image/*', on: { change: async (e) => {
            const f = e.target.files[0];
            if (!f) return;
            if (f.size > 25 << 20) return toast('Maximum size is 25 MB', 'bad');
            const small = await downscale(f, 256);
            await api('POST', `/api/bots/${b.id}/avatar`, small, { headers: { 'Content-Type': 'image/jpeg' } });
            toast('Avatar set');
          } } }),
          h('p.hint', { style: { margin: 0 } }, 'Drag in an image or browse. It’s cropped to a square.')));
  };
  drawPic();
  return [
    h('div.field', h('label', 'Name'), name),
    h('div.field', h('label', 'Label'), label),
    h('div.field', h('label', 'Picture'), pic),
    h('div.list',
      h('div.list-row', h('div.grow', 'Notifications', h('small', 'Push notifications for this Bot')), sw(!!b.notify, (v) => patch({ notify: v }))),
      h('div.list-row', h('div.grow', 'Draft outgoing messages', h('small', 'Email, Slack and Teams messages wait for your Send')), sw(!!b.drafts, (v) => patch({ drafts: v }))),
      h('div.list-row', h('div.grow', 'Pinned', h('small', 'Keep at the top of the sidebar')), sw(!!b.pinned, (v) => patch({ pinned: v }))),
      h('div.list-row', h('div.grow', 'Primary Bot', h('small', b.is_primary ? 'Your main point of contact' : 'Make this your main point of contact')),
        b.is_primary ? h('span.pill.accent', 'Primary') : h('button.btn', { on: { click: () => api('POST', `/api/bots/${b.id}/primary`) } }, 'Make primary'))),
    h('div.row', { style: { flexWrap: 'wrap' } },
      h('button.btn', { on: { click: async () => { const r = await api('POST', `/api/bots/${b.id}/duplicate`); await refresh(); closeDrawer(); go(`#/chat/${r.chat.id}`); toast('Duplicated. Profile, skills and routines were copied; memory and history were not.'); } } }, 'Duplicate'),
      h('button.btn', { on: { click: () => patch({ hidden: !b.hidden }).then(() => toast(b.hidden ? 'Shown in sidebar' : 'Hidden. Routines keep running. Find it under Hidden Bots.')) } }, b.hidden ? 'Show in sidebar' : 'Hide from sidebar'),
      h('button.btn.danger', { on: { click: async () => {
        if (!await confirm(`Delete ${b.name}? This erases its profile, conversations, memory, routines and attachments. It can't be undone.`)) return;
        await api('DELETE', `/api/bots/${b.id}`); closeDrawer(); await refresh(); go('#/');
      } } }, 'Delete')),
    h('p.hint', { style: { margin: 0 } }, 'Personal Bots have no settings page for their job. To change what a Bot does, tell it in chat and ask it to remember.'),
  ];
}

function downscale(file, size) {
  return new Promise((resolve) => {
    const im = new Image();
    im.onload = () => {
      const c = document.createElement('canvas');
      c.width = c.height = size;
      const s = Math.min(im.width, im.height);
      c.getContext('2d').drawImage(im, (im.width - s) / 2, (im.height - s) / 2, s, s, 0, 0, size, size);
      c.toBlob(resolve, 'image/jpeg', 0.88);
    };
    im.src = URL.createObjectURL(file);
  });
}

// ---------- Routines ----------------------------------------------------------------------
async function routinesTab(b) {
  const list = await api('GET', `/api/bots/${b.id}/routines`);
  const add = h('button.btn.primary', { on: { click: () => addRoutine(b) } }, icon('plus'), 'Add routine');
  if (!list.length) return [h('p.hint', { style: { margin: 0 } }, 'No routines yet. Ask the Bot in chat (“every weekday at 8am…”), or add one here. Routines keep running when this app is closed.'), h('div', add)];
  return [
    h('div.list', list.map((r) => h('div.list-row', { style: { cursor: 'pointer' }, on: { click: (e) => { if (!e.target.closest('.switch')) routineDetail(b, r); } } },
      h('div.grow', r.name, h('small', r.paused ? 'Paused' : r.when_text)),
      sw(!r.paused, (v) => api('PATCH', `/api/routines/${r.id}`, { paused: !v }))))),
    h('div', add),
    h('p.hint', { style: { margin: 0 } }, 'A Bot can own up to 50 routines. Schedules must be at least five minutes apart. Every run uses your Claude usage.'),
  ];
}

function addRoutine(b) {
  const name = h('input.input', { placeholder: 'Morning inbox brief' });
  const instruction = h('textarea.textarea', { placeholder: 'What should the Bot do each run? Include sources, the expected result, approval boundary and what to do if a source is missing.' });
  const trigger = h('select.select', h('option', { value: 'schedule' }, 'On a schedule'), h('option', { value: 'webhook' }, 'When a webhook is called'));
  const schedule = h('input.input', { placeholder: 'e.g. weekdays at 8am, every 3 hours' });
  const preview = h('div.hint');
  let t;
  schedule.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(async () => {
      if (!schedule.value.trim()) return (preview.textContent = '');
      preview.textContent = 'Reading schedule…';
      try { const r = await api('POST', '/api/schedule/preview', { text: schedule.value }); preview.textContent = `When to run: ${r.when}`; }
      catch (e) { preview.textContent = e.message; }
    }, 700);
  });
  const schedField = h('div.field', h('label', 'When to run'), schedule, preview);
  trigger.addEventListener('change', () => (schedField.hidden = trigger.value !== 'schedule'));
  modal({ title: `Add routine for ${b.name}`, body: [
    h('div.field', h('label', 'Name'), name),
    h('div.field', h('label', 'Instruction'), instruction),
    h('div.field', h('label', 'Trigger'), trigger),
    schedField,
    h('p.hint', { style: { margin: 0 } }, 'A new routine waits for its next scheduled time. Use Test to run it now.'),
  ], actions: [{ label: 'Cancel' }, { label: 'Create', primary: true, onClick: async () => {
    await api('POST', `/api/bots/${b.id}/routines`, { name: name.value.trim(), instruction: instruction.value.trim(), trigger: trigger.value, schedule: schedule.value.trim() });
    toast('Routine created'); paint();
  } }] });
}

function routineDetail(b, r) {
  const runs = r.runs || [];
  const body = [
    h('dl.kv',
      h('dt', 'Active'), h('dd', r.paused ? 'Paused' : 'Active'),
      h('dt', 'When to run'), h('dd', r.when_text || '—'),
      r.next_run && !r.paused && [h('dt', 'Next run'), h('dd', new Date(r.next_run).toLocaleString())],
      h('dt', 'Instruction'), h('dd', { style: { wordBreak: 'normal', whiteSpace: 'pre-wrap' } }, r.instruction)),
    r.trigger === 'webhook' && h('div.field', h('label', 'Webhook'),
      copyField('POST URL', r.webhook_url), copyField('Secret key', r.webhook_secret), copyField('Authorization header', `Bearer ${r.webhook_secret}`),
      h('p.hint', { style: { margin: 0 } }, 'Send an HTTP POST with that header and an optional JSON body. 200 means a run started (not that it finished). For services on the internet to reach it, expose Tandem with a tunnel (see README).'),
      h('button.btn', { on: { click: async () => { await api('POST', `/api/routines/${r.id}/rotate`); toast('New key created'); m.close(); paint(); } } }, 'Rotate key')),
    h('div.field', h('label', 'Run history'), runs.length
      ? h('div.list', runs.map((x) => h('div.list-row', h('div.grow', time(x.started), x.reason && h('small', x.reason)),
        h(`span.pill${x.status === 'Succeeded' ? '.good' : x.status === 'Failed' ? '.bad' : '.warn'}`, x.status))))
      : h('p.hint', { style: { margin: 0 } }, 'No runs yet.')),
  ];
  const m = modal({ title: r.name, wide: true, body, actions: [
    { label: 'Delete routine', danger: true, onClick: async () => { if (!await confirm('Delete this routine? Future runs stop permanently.')) return false; await api('DELETE', `/api/routines/${r.id}`); paint(); } },
    { label: r.paused ? 'Resume' : 'Pause', onClick: async () => { await api('PATCH', `/api/routines/${r.id}`, { paused: !r.paused }); paint(); } },
    { label: 'Edit', onClick: () => { closeDrawer(); const dm = dmOf(b.id); go(`#/chat/${dm.id}`);
      setTimeout(() => { const ta = document.querySelector('.composer textarea'); if (ta) { ta.value = `Update the routine "${r.name}": `; ta.focus(); } }, 120); } },
    { label: 'Test', primary: true, onClick: async () => { const res = await api('POST', `/api/routines/${r.id}/test`); toast(res.ok ? 'Running… results appear in the Bot’s chat' : `Couldn't start a test run: ${res.reason}`, res.ok ? '' : 'bad'); } },
  ] });
}

function copyField(label, value) {
  const input = h('input.input', { value, readOnly: true });
  return h('div', { style: { display: 'grid', gap: '4px' } }, h('span.hint', label),
    h('div.copy-field', input, h('button.btn', { on: { click: () => { navigator.clipboard.writeText(value); toast('Copied'); } } }, 'Copy')));
}

// ---------- Library -----------------------------------------------------------------------
async function libraryTab(b) {
  const items = await api('GET', `/api/bots/${b.id}/library`);
  if (!items.length) return [h('p.hint', { style: { margin: 0 } }, 'Pages, images, videos, files and links this Bot produces show up here.')];
  const kinds = ['page', 'image', 'video', 'file', 'link'];
  return kinds.filter((k) => items.some((i) => i.kind === k)).map((k) => h('div.field', h('label', `${k[0].toUpperCase()}${k.slice(1)}s`),
    h('div.list', items.filter((i) => i.kind === k).map((i) => {
      const href = /^https?:/.test(i.ref) ? i.ref : fileUrl(i.ref);
      return h('a.list-row', { href, target: '_blank', style: { textDecoration: 'none', color: 'inherit' } },
        k === 'image' ? h('img', { src: href, style: { width: '44px', height: '44px', objectFit: 'cover', borderRadius: '6px' } }) : null,
        h('div.grow', i.title, h('small', i.ref)), h('span.pill', i.visibility), h('span.hint', ago(i.created)));
    }))));
}

// ---------- Memory ------------------------------------------------------------------------
async function memoryTab(b) {
  const m = await api('GET', `/api/bots/${b.id}/memory`);
  const dm = dmOf(b.id);
  const facts = m.bot.facts;
  const shared = m.you.facts;
  return [
    h('p.hint', { style: { margin: 0 } }, 'Bots decide what to save. To correct or remove something, ask the Bot in chat (“forget that I…”). Memory is not a source of truth.'),
    h('div.field', h('label', `${b.name}'s memory`), facts.length ? h('div.list', facts.map((f) => h('div.list-row', h('div.grow', f.text, h('small', time(Date.parse(f.at))))))) : h('p.hint', { style: { margin: 0 } }, 'Nothing yet.')),
    h('div.field', h('label', 'About you (shared by all Bots)'), shared.length ? h('div.list', shared.map((f) => h('div.list-row', h('div.grow', f.text, h('small', `saved by ${bot(f.bot)?.name || 'a Bot'}`))))) : h('p.hint', { style: { margin: 0 } }, 'Nothing yet.')),
    m.bot.log.length ? h('div.field', h('label', 'Work log'), h('div.list', m.bot.log.slice(-30).reverse().map((l) => h('div.list-row', h('div.grow', l.text, h('small', time(Date.parse(l.at)))))))) : null,
    dm && h('button.btn', { on: { click: () => { closeDrawer(); go(`#/chat/${dm.id}`); setTimeout(() => { const ta = document.querySelector('.composer textarea'); if (ta) { ta.value = 'What do you remember about me and your job?'; ta.focus(); } }, 120); } } }, 'Ask what it remembers'),
  ];
}
