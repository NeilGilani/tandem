// Full-page views: Connect apps, Skills, Settings, Bot templates.
import { api, h, avatar, icon, toast, modal, confirm, sw, logo, time, md, menu } from './lib.js';
import { S, bot, dmOf, refresh, go, toggleComputer } from './store.js';

const page = ($main, title, lede, ...content) => {
  $main.replaceChildren(h('div.page', h('div.page-in',
    h('div.hstack', h('button.icon-btn.back-btn', { on: { click: () => go('#/') } }, icon('back')), h('h1', title)),
    lede && h('p.lede', lede), ...content)));
};

// ---------- Connect apps -------------------------------------------------------------------
let appFilter = 'All', appQuery = '', appTab = 'apps', appBot = null;

export async function renderApps($main) {
  if (appBot && !bot(appBot)) appBot = null;
  const data = await api('GET', `/api/connectors${appBot ? `?bot=${encodeURIComponent(appBot)}` : ''}`);
  appBot = data.bot;
  const forBot = bot(appBot);
  const botPicker = forBot ? h('button.btn', { on: { click: (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    menu(r.left, r.bottom + 4, S.bots.map((x) => ({ label: x.name, onClick: () => { appBot = x.id; renderApps($main); } })));
  } } }, avatar(forBot, 18), `For ${forBot.name}`) : null;
  const signIn = async (id, name) => {
    await api('POST', `/api/connectors/${id}/signin`, { botId: appBot });
    toast(`Sign in to ${name} in the window that opened, then press I'm done`);
    S.focusBot = appBot; toggleComputer(true);
  };
  const tabs = h('div.tabs', [['apps', 'Apps'], ['installed', `Connected (${data.installed.length})`], ['skills', 'Private skills'], ['custom', 'Custom app (MCP)']].map(([k, l]) =>
    h(`button${appTab === k ? '.on' : ''}`, { on: { click: () => { appTab = k; renderApps($main); } } }, l)));

  let content;
  if (appTab === 'apps') {
    const search = h('input.input', { placeholder: 'Search apps', value: appQuery, style: { maxWidth: '280px' }, on: { input: (e) => { appQuery = e.target.value; drawGrid(); } } });
    const chips = h('div.filter-row');
    const grid = h('div.grid');
    const drawChips = () => chips.replaceChildren(...['All', ...data.categories].map((c) => h(`button.chip-btn${appFilter === c ? '.on' : ''}`, { on: { click: () => { appFilter = c; drawChips(); drawGrid(); } } }, c)));
    const drawGrid = () => {
      const q = appQuery.toLowerCase();
      grid.replaceChildren(...data.catalog.filter((a) => (appFilter === 'All' || a.category === appFilter) && (!q || a.name.toLowerCase().includes(q))).map(appTile));
    };
    drawChips(); drawGrid();
    content = [h('div.hstack', { style: { marginBottom: '12px' } }, search), chips, grid];
  } else if (appTab === 'installed') {
    content = data.installed.length ? h('div.list', data.installed.map((c) => h('div.list-row',
      c.catalog_id === 'custom' ? h('span.logo', { style: { background: '#334155' } }, '⚙︎') : logo(c),
      h('div.grow', c.name, h('small', c.catalog_id === 'custom' ? (c.config?.url || `${c.config?.command} ${(c.config?.args || []).join(' ')}`) : c.category)),
      statusPill(c.status), actionsFor(c, () => renderApps($main), signIn))))
      : h('p.hint', 'Nothing connected yet.');
  } else if (appTab === 'skills') {
    content = await privateSkills();
  } else {
    content = customAppForm(() => { appTab = 'installed'; renderApps($main); });
  }
  page($main, 'Connect apps', 'Each Bot has its own computer, so you sign in to apps per Bot. Pick a Bot, then add and sign in to the apps it should use. Its sign-ins stay on its computer. Mac apps and custom MCP apps work for every Bot.',
    h('div.hstack', { style: { marginBottom: '14px', flexWrap: 'wrap' } },
      botPicker,
      h('button.btn', { on: { click: () => api('POST', `/api/connectors/refresh?bot=${encodeURIComponent(appBot || '')}`).then(() => { toast('Checked sign-ins'); renderApps($main); }) } }, icon('refresh'), 'Check sign-ins'),
      h('button.btn', { on: { click: () => go('#/templates') } }, icon('template'), 'Bot templates'),
      h('button.btn', { on: { click: () => go('#/settings/vault') } }, icon('key'), 'Vault')),
    tabs, content);

  function appTile(a) {
    return h('div.tile',
      h('div.tile-h', logo(a), h('div', { style: { flex: 1 } }, h('b', a.name), h('div.hint', a.category)), a.status && statusPill(a.status)),
      h('p', a.tips),
      h('div.hstack', a.installed_id ? actionsFor({ ...a, id: a.installed_id }, () => renderApps($main), signIn) :
        h('button.btn', { on: { click: async () => {
          const row = await api('POST', '/api/connectors', { catalogId: a.id });
          if (a.kind === 'browser' && appBot) await signIn(row.id, a.name);
          else toast(`${a.name} connected. macOS asks for permission the first time a Bot uses it.`);
          renderApps($main);
        } } }, icon('plus'), 'Add')));
  }
}

function statusPill(s) {
  const cls = s === 'Connected' ? '.good' : s === 'Needs auth' || s === 'Disconnected' ? '.bad' : '.warn';
  return h(`span.pill${cls}`, s);
}

function actionsFor(c, after, signIn) {
  const kind = c.kind || (c.catalog_id === 'custom' ? 'custom' : 'browser');
  return h('div.hstack', { style: { gap: '6px' } },
    kind === 'browser' && h('button.btn', { on: { click: () => signIn(c.id, c.name) } }, c.status === 'Connected' ? 'Reconnect' : 'Sign in'),
    kind === 'browser' && c.status !== 'Connected' && h('button.btn.ghost', { title: 'Mark as signed in', on: { click: () => api('POST', `/api/connectors/${c.id}/connected`, { botId: appBot }).then(after) } }, 'I’m signed in'),
    h('button.btn.ghost.danger', { on: { click: async () => {
      if (!await confirm(`Remove ${c.name} for all Bots? This signs every Bot's computer out of it.`, { label: 'Remove' })) return;
      await api('DELETE', `/api/connectors/${c.id}`); after();
    } } }, 'Remove'));
}

function customAppForm(done) {
  const name = h('input.input', { placeholder: 'e.g. Postgres, Internal API' });
  const mode = h('select.select', h('option', { value: 'url' }, 'By URL (remote MCP server)'), h('option', { value: 'command' }, 'By command run on this computer'));
  const url = h('input.input', { placeholder: 'https://example.com/mcp' });
  const cmd = h('input.input', { placeholder: 'npx -y @modelcontextprotocol/server-postgres postgresql://localhost/db' });
  const env = h('textarea.textarea', { rows: 3, placeholder: 'KEY=value (one per line, optional)' });
  const urlF = h('div.field', h('label', 'URL'), url);
  const cmdF = h('div.field', { hidden: true }, h('label', 'Command'), cmd, h('label', 'Environment'), env);
  mode.addEventListener('change', () => { urlF.hidden = mode.value !== 'url'; cmdF.hidden = mode.value === 'url'; });
  return h('div', { style: { display: 'grid', gap: '14px', maxWidth: '560px' } },
    h('p.hint', { style: { margin: 0 } }, 'Add any MCP server as an app. Its tools become available to every Bot. Servers on a private network need your approval per action.'),
    h('div.field', h('label', 'Name'), name), h('div.field', h('label', 'How to connect'), mode), urlF, cmdF,
    h('div', h('button.btn.primary', { on: { click: async () => {
      try {
        const body = { name: name.value.trim() };
        if (mode.value === 'url') body.url = url.value.trim();
        else {
          const parts = cmd.value.trim().match(/(?:[^\s"]+|"[^"]*")+/g) || [];
          body.command = parts[0]; body.args = parts.slice(1).map((p) => p.replace(/^"|"$/g, ''));
          body.env = Object.fromEntries(env.value.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => [l.split('=')[0], l.split('=').slice(1).join('=')]));
        }
        await api('POST', '/api/connectors/custom', body); toast(`${body.name} added`); done();
      } catch (e) { toast(e.message, 'bad'); }
    } } }, 'Add app')));
}

async function privateSkills() {
  const { skills, disabled } = await api('GET', '/api/skills');
  if (!skills.length) return h('p.hint', 'No skills yet. Ask a Bot to save a completed process as a skill, or use Teach a task.');
  const off = new Set(disabled.map((d) => `${d.bot_id}:${d.slug}`));
  return h('div', { style: { overflowX: 'auto' } }, h('table.list', { style: { borderCollapse: 'collapse', width: '100%' } },
    h('tr', h('th', { style: { textAlign: 'left', padding: '10px 14px' } }, 'Skill'), S.bots.map((b) => h('th', { style: { padding: '8px' } }, avatar(b, 22), h('div.hint', b.name)))),
    skills.map((s) => h('tr', { style: { borderTop: '1px solid var(--line)' } },
      h('td', { style: { padding: '10px 14px' } }, h('b', s.name), h('div.hint', s.description)),
      S.bots.map((b) => h('td', { style: { textAlign: 'center' } }, sw(!off.has(`${b.id}:${s.slug}`), (v) => api('POST', `/api/skills/${s.slug}/enabled`, { botId: b.id, on: v }))))))));
}

// ---------- Skills -------------------------------------------------------------------------
export async function renderSkills($main, r) {
  const { skills } = await api('GET', '/api/skills');
  if (r.id) {
    const s = r.id === 'new' ? { name: '', description: '', body: '## When to use\n\n## Inputs and access needed\n\n## Steps\n1. \n\n## Validation\n\n## What to return\n\n## Approval needed before\n' } : await api('GET', `/api/skills/${r.id}`);
    const name = h('input.input', { value: s.name });
    const desc = h('input.input', { value: s.description, placeholder: 'When to use it — Bots use this to decide' });
    const body = h('textarea.textarea', { value: s.body, rows: 22, style: { fontFamily: 'var(--mono)', fontSize: '12.5px' } });
    return page($main, r.id === 'new' ? 'New skill' : s.name, null,
      h('div', { style: { display: 'grid', gap: '14px' } },
        h('div.field', h('label', 'Name'), name), h('div.field', h('label', 'Description'), desc), h('div.field', h('label', 'Instructions'), body),
        h('div.hstack',
          h('button.btn.primary', { on: { click: async () => {
            try { const saved = r.id === 'new' ? await api('POST', '/api/skills', { name: name.value, description: desc.value, body: body.value }) : await api('PUT', `/api/skills/${r.id}`, { name: name.value, description: desc.value, body: body.value });
              toast('Saved'); go(`#/skills/${saved.slug}`); } catch (e) { toast(e.message, 'bad'); }
          } } }, 'Save'),
          h('button.btn', { on: { click: () => go('#/skills') } }, 'Back'),
          r.id !== 'new' && h('button.btn.danger', { style: { marginLeft: 'auto' }, on: { click: async () => { if (await confirm(`Delete the skill "${s.name}"?`)) { await api('DELETE', `/api/skills/${r.id}`); go('#/skills'); } } } }, 'Delete'))));
  }
  page($main, 'Skills', 'One private library shared by all your Bots. A good skill says when to use it, the inputs and access it needs, the steps, how to validate, what to return, and which steps need approval. A Bot may still need the app or login to use a skill.',
    h('div.hstack', { style: { marginBottom: '14px' } }, h('button.btn.primary', { on: { click: () => go('#/skills/new') } }, icon('plus'), 'New skill'),
      h('span.hint', 'Or open a Bot’s chat → ⋯ → Teach a task')),
    skills.length ? h('div.list', skills.map((s) => h('div.list-row', { style: { cursor: 'pointer' }, on: { click: () => go(`#/skills/${s.slug}`) } },
      icon('book'), h('div.grow', s.name, h('small', s.description)), h('span.hint', time(s.updated)))))
      : h('p.hint', 'No skills yet.'));
}

// ---------- Templates ------------------------------------------------------------------------
export async function renderTemplates($main) {
  const list = await api('GET', '/api/templates');
  page($main, 'Bot templates', 'Import a template to add your own copy. Templates include identity, a job and suggested apps — never your computer, logins or conversation history.',
    h('div.grid', list.map((t) => h('div.tile',
      h('div.tile-h', avatar(t, 34), h('div', h('b', t.name), h('div.hint', t.label))),
      h('p', t.job[0].replace(/^My job is to /, '').replace(/^./, (c) => c.toUpperCase())),
      h('div.hint', `Apps: ${t.apps.join(', ')}`),
      h('div', h('button.btn', { on: { click: async () => { const r = await api('POST', `/api/templates/${t.id}/import`); await refresh(); go(`#/chat/${r.chat.id}`); toast(`${t.name} added`); } } }, 'Import Bot'))))));
}

// ---------- Settings -------------------------------------------------------------------------
export async function renderSettings($main, r) {
  const t = r.id || 'general';
  const st = await api('GET', '/api/settings');
  const tabs = h('div.tabs', [['general', 'General'], ['computer', 'Computer'], ['vault', 'Vault'], ['devices', 'Devices'], ['usage', 'Usage']].map(([k, l]) =>
    h(`button${t === k ? '.on' : ''}`, { on: { click: () => go(`#/settings/${k}`) } }, l)));
  const patch = (p) => api('PATCH', '/api/settings', p).then(() => renderSettings($main, r)).catch((e) => toast(e.message, 'bad'));
  let content;

  if (t === 'general') {
    const ruleList = (kind, title) => {
      const rules = st.rules.filter((x) => x.kind === kind);
      const input = h('input.input', { placeholder: kind === 'allow' ? 'e.g. Reading and archiving Gmail newsletters' : 'e.g. Anything in Salesforce that changes an opportunity stage' });
      return h('div.field', h('label', `${title} (${rules.length}/20)`),
        rules.length ? h('div.list', rules.map((x) => h('div.list-row', h('div.grow', x.text), h('button.btn.ghost.danger', { on: { click: () => api('DELETE', `/api/rules/${x.id}`).then(() => renderSettings($main, r)) } }, 'Remove')))) : h('div.hint', 'No rules.'),
        h('div.hstack', input, h('button.btn', { on: { click: () => input.value.trim() && api('POST', '/api/rules', { kind, text: input.value.trim() }).then(() => renderSettings($main, r)).catch((e) => toast(e.message, 'bad')) } }, 'Add Rule')));
    };
    const zones = Intl.supportedValuesOf ? Intl.supportedValuesOf('timeZone') : [st.resolved_timezone];
    const tz = h('select.select', h('option', { value: 'auto', selected: st.timezone === 'auto' }, `Auto-detect (${Intl.DateTimeFormat().resolvedOptions().timeZone})`),
      zones.map((z) => h('option', { value: z, selected: st.timezone === z }, z)));
    tz.addEventListener('change', () => patch({ timezone: tz.value }));
    const theme = h('select.select', ['system', 'light', 'dark'].map((x) => h('option', { value: x, selected: st.theme === x }, x[0].toUpperCase() + x.slice(1))));
    theme.addEventListener('change', () => patch({ theme: theme.value }));
    const importBox = h('textarea.textarea', { rows: 5, placeholder: 'Paste memory exported from another assistant (one fact per line)' });
    content = [
      h('h2', 'Bot'),
      h('div.list', h('div.list-row', h('div.grow', 'Auto Review', h('small', 'Checks each action and either lets it run or asks you first. Built-in safety checks always apply. When off, actions run without checks and Custom Rules are kept but not used.')),
        sw(st.auto_review, (v) => patch({ auto_review: v })))),
      h('h2', 'Custom Rules'),
      h('p.hint', 'Describe an action and choose Allow automatically or Ask first. If both match, Ask first wins. Keep rules short and narrow — Auto Review is model-based, so it complements least privilege rather than replacing it.'),
      ruleList('allow', 'Allow automatically'),
      h('div', { style: { height: '12px' } }),
      ruleList('ask', 'Ask first'),
      h('h2', 'Your name'), h('div.field', h('input.input', { value: st.user_name || '', style: { maxWidth: '320px' }, on: { change: (e) => patch({ user_name: e.target.value }) } }), h('div.hint', 'Shown in the sidebar.')),
      h('h2', 'Timezone'), h('div.field', tz, h('div.hint', 'Routines use this time zone.')),
      h('h2', 'Appearance'), h('div.field', theme),
      h('h2', 'Import memory'), h('div.field', importBox, h('div.hint', 'Imported memory goes to your primary Bot as facts about you, shared with all Bots.')),
      h('div', h('button.btn', { on: { click: async () => { const res = await api('POST', '/api/memory/import', { text: importBox.value }); toast(`Imported ${res.imported} facts into ${res.bot}`); importBox.value = ''; } } }, 'Start Import')),
    ];
  } else if (t === 'computer') {
    const exec = h('select.select', [['ask', 'Ask every time'], ['always', 'Always allow'], ['never', 'Never allow']].map(([v, l]) => h('option', { value: v, selected: st.local_execution === v }, l)));
    exec.addEventListener('change', () => patch({ local_execution: exec.value }));
    content = [
      h('h2', 'Your computer'),
      h('div.field', h('label', 'Execution on this computer'), exec, h('div.hint', 'Whether Bots may run commands on this Mac. Ask every time shows an approval card with Allow, Skip and Always allow.')),
      h('h2', 'Bot computers'),
      h('p.hint', 'Each Bot has its own computer: its own browser with its own sign-ins, and its own files folder. A browser starts when its Bot starts work and goes to sleep after 15 minutes idle. Sign-ins are kept. Commands still run on this Mac.'),
      h('dl.kv', h('dt', 'Shared folder'), h('dd', h('code', st.shared || '')), h('dt', 'Bot folders'), h('dd', h('code', st.workspace || ''))),
      S.bots.length ? h('div.list', S.bots.map((b) => {
        const c = S.computers[b.id] || {};
        const body = { botId: b.id };
        return h('div.list-row', avatar(b, 26), h('div.grow', b.name, h('small', c.running ? (c.activity || 'Awake') : 'Asleep')),
          h('button.btn', { on: { click: () => { S.focusBot = b.id; toggleComputer(true); } } }, 'View'),
          h('button.btn.ghost', { on: { click: () => api('POST', '/api/computer/focus', body) } }, 'Show window'),
          h('button.btn.ghost', { on: { click: () => api('POST', '/api/computer/restart', body).then(() => toast(`Restarted ${b.name}'s browser`)) } }, 'Restart'));
      })) : h('p.hint', 'No Bots yet.'),
    ];
  } else if (t === 'vault') {
    const items = await api('GET', '/api/vault');
    const name = h('input.input', { placeholder: 'Name, e.g. Salesforce login' });
    const site = h('input.input', { placeholder: 'Site, e.g. salesforce.com' });
    const user = h('input.input', { placeholder: 'Username or email', autocomplete: 'off' });
    const secret = h('input.input', { type: 'password', placeholder: 'Password or secret', autocomplete: 'new-password' });
    content = [
      h('p.hint', 'The first place Bots look for a saved login. Values are stored in your Mac Keychain and filled into sign-in pages without the Bot ever seeing them. Never paste passwords or codes into chat.'),
      items.length ? h('div.list', items.map((v) => h('div.list-row', icon('key'), h('div.grow', v.name, h('small', [v.site, v.username].filter(Boolean).join(' · '))),
        h('button.btn.ghost.danger', { on: { click: async () => { if (await confirm(`Delete ${v.name} from the Vault?`)) { await api('DELETE', `/api/vault/${v.id}`); renderSettings($main, r); } } } }, 'Delete')))) : h('p.hint', 'Nothing saved.'),
      h('h2', 'Add a login'),
      h('div', { style: { display: 'grid', gap: '8px', maxWidth: '440px' } }, name, site, user, secret,
        h('div', h('button.btn.primary', { on: { click: async () => {
          try { await api('POST', '/api/vault', { name: name.value.trim(), site: site.value.trim(), username: user.value.trim(), secret: secret.value, kind: 'login' }); toast('Saved to Vault'); renderSettings($main, r); }
          catch (e) { toast(e.message, 'bad'); }
        } } }, 'Save'))),
    ];
  } else if (t === 'devices') {
    content = [
      h('h2', 'Manage your devices'),
      h('p.hint', 'Tandem runs on this Mac. Use it from your phone or another computer on the same network — it installs like an app (Share → Add to Home Screen on iPhone; Install app in Chrome).'),
      st.lan ? h('div.field', h('label', 'Open this link on your phone (keep it private — it signs the device in)'),
        st.lan_urls.map((u) => h('div.copy-field', h('input.input', { value: u, readOnly: true }), h('button.btn', { on: { click: () => { navigator.clipboard.writeText(u); toast('Copied'); } } }, 'Copy'))))
        : h('div.card', { style: { maxWidth: 'none' } }, h('div.card-b', h('div', 'Phone access is off. Restart Tandem with network access:'), h('pre', 'tandem start --lan'),
          h('div.hint', 'Away from home, put this Mac and your phone on the same Tailscale network and use its Tailscale address.'))),
    ];
  } else if (t === 'usage') {
    const u = await api('GET', '/api/usage');
    const guardAt = h('select.select', { style: { width: 'auto' } }, [[0.8, '80%'], [0.9, '90%'], [0.95, '95%']].map(([v, l]) => h('option', { value: v, selected: Math.abs(st.usage_guard_at - v) < 0.001 }, l)));
    guardAt.addEventListener('change', () => patch({ usage_guard_at: Number(guardAt.value) }));
    const rm = h('select.select', { style: { width: 'auto' } }, [['balanced', 'Balanced (Sonnet)'], ['economy', 'Economy (Haiku)']].map(([v, l]) => h('option', { value: v, selected: st.routine_model === v }, l)));
    rm.addEventListener('change', () => patch({ routine_model: rm.value }));
    content = [
      h('h2', 'Your Claude plan'),
      h('p.hint', 'Bots run on your Claude Code plan, so every reply, routine and test counts toward its limits. These numbers come straight from Claude.'),
      planBars(u.plan),
      h('h2', 'Protect your plan'),
      h('div.list',
        h('div.list-row', h('div.grow', 'Pause routines when the plan is nearly used up', h('small', 'Scheduled routines are skipped, and you get one notification. Chats still work.')), sw(st.usage_guard, (v) => patch({ usage_guard: v }))),
        h('div.list-row', h('div.grow', 'Pause routines at', h('small', 'Share of your weekly limit')), guardAt),
        h('div.list-row', h('div.grow', 'Model for routines', h('small', 'Economy uses far less of your plan, but is less capable')), rm)),
      h('h2', 'Last 7 days'),
      h('dl.kv', h('dt', 'Bot turns'), h('dd', String(u.week.turns))),
      h('div.list', { style: { marginTop: '12px' } }, u.byBot.map((x) => h('div.list-row', h('div.grow', x.bot || 'Deleted Bot', h('small', `${x.model}, ${x.turns} turns, ${Math.round((x.input_tokens + x.output_tokens) / 1000)}k tokens`))))),
    ];
  }
  page($main, 'Settings', null, tabs, ...[content].flat());
}

// ---------- Activity -------------------------------------------------------------------------
let actBot = null, actKind = '', actDay = null, actQuery = '';
const ACT_KINDS = [['', 'Everything'], ['tool', 'Actions'], ['approval', 'Approvals'], ['draft', 'Drafts'], ['handoff', 'Handoffs'], ['error', 'Problems']];
const dayStr = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export async function renderActivity($main) {
  const today = new Date();
  actDay ||= dayStr(today);
  const params = new URLSearchParams({ day: actDay });
  if (actBot) params.set('bot', actBot);
  if (actKind && actKind !== 'tool') params.set('kind', actKind);
  if (actQuery) params.set('q', actQuery);
  const { items } = await api('GET', `/api/activity?${params}`);
  const shown = actKind === 'tool' ? items.filter((i) => i.kind === 'tool') : items;

  // Group each run's steps under the run.
  const runs = new Map();
  const blocks = [];
  for (const it of [...shown].reverse()) {
    if (it.kind === 'run') { const b = { run: it, steps: [] }; runs.set(it.run_id, b); blocks.push(b); continue; }
    const b = it.run_id && runs.get(it.run_id);
    if (b) b.steps.push(it); else blocks.push({ run: null, steps: [it] });
  }
  blocks.reverse();

  const statusPillA = (st) => {
    const map = { ok: ['Done', 'good'], running: ['Working', 'warn'], pending: ['Waiting for you', 'warn'], allowed: ['Allowed', 'good'], denied: ['Denied', 'bad'],
      expired: ['Expired', ''], error: ['Failed', 'bad'], stopped: ['Stopped', ''], sent: ['Sent', 'good'], discarded: ['Discarded', ''] };
    const [l, c] = map[st] || [st, ''];
    return h(`span.pill${c ? '.' + c : ''}`, l);
  };
  const t = (ts) => new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const row = (it, nested) => {
    const b = bot(it.bot_id);
    const det = it.detail && h('details.cmd-details', h('summary', 'Details'), h('pre', it.detail));
    return h('div.list-row', { style: { alignItems: 'flex-start', paddingLeft: nested ? '44px' : '14px' } },
      nested ? null : (b ? avatar(b, 26) : h('span.initials', '?')),
      h('div.grow', h('div', { style: { color: it.kind === 'error' ? 'var(--bad)' : 'var(--text)' } }, it.summary), det,
        h('small', [t(it.created), nested ? null : b?.name, it.origin === 'routine' ? 'routine' : null].filter(Boolean).join(' · '))),
      statusPillA(it.status),
      it.chat_id && !nested && h('button.btn.ghost', { on: { click: () => go(`#/chat/${it.chat_id}`) } }, 'Open chat'));
  };

  const days = [0, 1, 2, 3, 4, 5, 6].map((n) => { const d = new Date(); d.setDate(d.getDate() - n); return d; });
  const daySel = h('select.select', { style: { width: 'auto' } }, days.map((d, i) => h('option', { value: dayStr(d), selected: dayStr(d) === actDay }, i === 0 ? 'Today' : i === 1 ? 'Yesterday' : d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' }))));
  daySel.addEventListener('change', () => { actDay = daySel.value; renderActivity($main); });
  const search = h('input.input', { placeholder: 'Search activity', value: actQuery, style: { maxWidth: '240px' }, on: { change: (e) => { actQuery = e.target.value.trim(); renderActivity($main); } } });
  const botSel = h('select.select', { style: { width: 'auto' } }, h('option', { value: '' }, 'All Bots'), S.bots.map((b) => h('option', { value: b.id, selected: b.id === actBot }, b.name)));
  botSel.addEventListener('change', () => { actBot = botSel.value || null; renderActivity($main); });

  const counts = { done: items.filter((i) => i.kind === 'tool' && i.status === 'ok').length, denied: items.filter((i) => i.status === 'denied').length, errors: items.filter((i) => i.kind === 'error' || i.status === 'error').length };
  page($main, 'Activity', 'Everything your Bots did: what they opened, ran, sent and changed, what they asked you about, and what went wrong.',
    h('div.hstack', { style: { flexWrap: 'wrap', marginBottom: '12px' } }, daySel, botSel, search),
    h('div.filter-row', ACT_KINDS.map(([k, l]) => h(`button.chip-btn${actKind === k ? '.on' : ''}`, { on: { click: () => { actKind = k; renderActivity($main); } } }, l))),
    h('p.hint', `${counts.done} actions done${counts.denied ? `, ${counts.denied} denied` : ''}${counts.errors ? `, ${counts.errors} problems` : ''}.`),
    blocks.length ? blocks.map((bl) => h('div.list', { style: { marginBottom: '10px' } },
      bl.run ? row(bl.run, false) : null,
      bl.run && bl.steps.length > 6
        ? [bl.steps.slice(0, 3).map((x) => row(x, true)), h('details', h('summary.list-row', { style: { paddingLeft: '44px', cursor: 'pointer', color: 'var(--text-3)', fontSize: '12.5px' } }, `${bl.steps.length - 3} more steps`), bl.steps.slice(3).map((x) => row(x, true)))]
        : bl.steps.map((x) => row(x, !!bl.run)))) : h('p.hint', 'Nothing yet for this day.'));
}

// ---------- Plan usage meter (used in Settings and the sidebar) ------------------------------
export function planBars(plan, { compact = false } = {}) {
  if (!plan || (!plan.fiveHour && !plan.week)) return compact ? null : h('p.hint', 'Usage shows up after your Bots’ next reply.');
  const bar = (label, w) => {
    if (!w) return null;
    const pct = Math.round((w.used || 0) * 100);
    const color = pct >= 90 ? 'var(--bad)' : pct >= 70 ? 'var(--warn)' : 'var(--good)';
    const resets = w.resetsAt ? new Date(w.resetsAt).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : '';
    return h('div', { style: { display: 'grid', gap: '4px' } },
      h('div.hstack', { style: { justifyContent: 'space-between', gap: '8px', fontSize: compact ? '11.5px' : '13px', whiteSpace: 'nowrap' } }, h('span', label), h('span.hint', { style: { fontSize: 'inherit', overflow: 'hidden', textOverflow: 'ellipsis' } }, `${pct}% used${resets ? ` · resets ${resets}` : ''}`)),
      h('div', { style: { height: compact ? '4px' : '6px', borderRadius: '99px', background: 'var(--line)', overflow: 'hidden' } },
        h('div', { style: { width: `${Math.min(pct, 100)}%`, height: '100%', background: color, borderRadius: '99px' } })));
  };
  return h('div', { style: { display: 'grid', gap: compact ? '6px' : '12px' } }, bar('5-hour limit', plan.fiveHour), bar('Weekly limit', plan.week));
}
