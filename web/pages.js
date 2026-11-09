// Full-page views: Connect apps, Skills, Settings, Bot templates.
import { api, h, avatar, icon, toast, modal, confirm, sw, logo, time, md } from './lib.js';
import { S, bot, dmOf, refresh, go, toggleComputer } from './store.js';

const page = ($main, title, lede, ...content) => {
  $main.replaceChildren(h('div.page', h('div.page-in',
    h('div.row', h('button.icon-btn.back-btn', { on: { click: () => go('#/') } }, icon('back')), h('h1', title)),
    lede && h('p.lede', lede), ...content)));
};

// ---------- Connect apps -------------------------------------------------------------------
let appFilter = 'All', appQuery = '', appTab = 'apps';

export async function renderApps($main) {
  const data = await api('GET', '/api/connectors');
  const tabs = h('div.tabs', [['apps', 'Apps'], ['installed', `Connected (${data.installed.length})`], ['skills', 'Private skills'], ['custom', 'Custom app (MCP)']].map(([k, l]) =>
    h(`button${appTab === k ? '.on' : ''}`, { on: { click: () => { appTab = k; renderApps($main); } } }, l)));

  let content;
  if (appTab === 'apps') {
    const search = h('input.input', { placeholder: 'Search apps', value: appQuery, style: { maxWidth: '280px' }, on: { input: (e) => { appQuery = e.target.value; drawGrid(); } } });
    const chips = h('div.filter-row');
    const grid = h('div.grid');
    const drawChips = () => chips.replaceChildren(...['All', ...data.categories].map((c) => h(`button.chip${appFilter === c ? '.on' : ''}`, { on: { click: () => { appFilter = c; drawChips(); drawGrid(); } } }, c)));
    const drawGrid = () => {
      const q = appQuery.toLowerCase();
      grid.replaceChildren(...data.catalog.filter((a) => (appFilter === 'All' || a.category === appFilter) && (!q || a.name.toLowerCase().includes(q))).map(appTile));
    };
    drawChips(); drawGrid();
    content = [h('div.row', { style: { marginBottom: '12px' } }, search), chips, grid];
  } else if (appTab === 'installed') {
    content = data.installed.length ? h('div.list', data.installed.map((c) => h('div.list-row',
      c.catalog_id === 'custom' ? h('span.logo', { style: { background: '#334155' } }, '⚙︎') : logo(c),
      h('div.grow', c.name, h('small', c.catalog_id === 'custom' ? (c.config?.url || `${c.config?.command} ${(c.config?.args || []).join(' ')}`) : c.category)),
      statusPill(c.status), actionsFor(c, () => renderApps($main)))))
      : h('p.hint', 'Nothing connected yet.');
  } else if (appTab === 'skills') {
    content = await privateSkills();
  } else {
    content = customAppForm(() => { appTab = 'installed'; renderApps($main); });
  }
  page($main, 'Connect apps', 'Sign in once and every Bot can use the app. Apps without an API connector are used through the computer’s browser — the session persists and is shared across your Bots. Mac apps run natively.',
    h('div.row', { style: { marginBottom: '14px', flexWrap: 'wrap' } },
      h('button.btn', { on: { click: () => api('POST', '/api/connectors/refresh').then(() => { toast('Checked sign-ins'); renderApps($main); }) } }, icon('refresh'), 'Check sign-ins'),
      h('button.btn', { on: { click: () => go('#/templates') } }, icon('template'), 'Bot templates'),
      h('button.btn', { on: { click: () => go('#/settings/vault') } }, icon('key'), 'Vault')),
    tabs, content);

  function appTile(a) {
    return h('div.tile',
      h('div.tile-h', logo(a), h('div', { style: { flex: 1 } }, h('b', a.name), h('div.hint', a.category)), a.status && statusPill(a.status)),
      h('p', a.tips),
      h('div.row', a.installed_id ? actionsFor({ ...a, id: a.installed_id }, () => renderApps($main)) :
        h('button.btn', { on: { click: async () => {
          const row = await api('POST', '/api/connectors', { catalogId: a.id });
          if (a.kind === 'browser') { await api('POST', `/api/connectors/${row.id}/signin`); toggleComputer(true); toast(`Sign in to ${a.name} in the computer, then press I'm done`); }
          else toast(`${a.name} connected. macOS asks for permission the first time a Bot uses it.`);
          renderApps($main);
        } } }, icon('plus'), 'Add')));
  }
}

function statusPill(s) {
  const cls = s === 'Connected' ? '.good' : s === 'Needs auth' || s === 'Disconnected' ? '.bad' : '.warn';
  return h(`span.pill${cls}`, s);
}

function actionsFor(c, after) {
  const kind = c.kind || (c.catalog_id === 'custom' ? 'custom' : 'browser');
  return h('div.row', { style: { gap: '6px' } },
    kind === 'browser' && h('button.btn', { on: { click: async () => { await api('POST', `/api/connectors/${c.id}/signin`); toggleComputer(true); toast(`Sign in to ${c.name}, then press I'm done`); } } },
      c.status === 'Connected' ? 'Reconnect' : 'Sign in'),
    kind === 'browser' && c.status !== 'Connected' && h('button.btn.ghost', { title: 'Mark as signed in', on: { click: () => api('POST', `/api/connectors/${c.id}/connected`).then(after) } }, 'I’m signed in'),
    h('button.btn.ghost.danger', { on: { click: async () => {
      if (!await confirm(`Remove ${c.name}? This signs the computer out of it.`, { label: 'Remove' })) return;
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
        h('div.row',
          h('button.btn.primary', { on: { click: async () => {
            try { const saved = r.id === 'new' ? await api('POST', '/api/skills', { name: name.value, description: desc.value, body: body.value }) : await api('PUT', `/api/skills/${r.id}`, { name: name.value, description: desc.value, body: body.value });
              toast('Saved'); go(`#/skills/${saved.slug}`); } catch (e) { toast(e.message, 'bad'); }
          } } }, 'Save'),
          h('button.btn', { on: { click: () => go('#/skills') } }, 'Back'),
          r.id !== 'new' && h('button.btn.danger', { style: { marginLeft: 'auto' }, on: { click: async () => { if (await confirm(`Delete the skill "${s.name}"?`)) { await api('DELETE', `/api/skills/${r.id}`); go('#/skills'); } } } }, 'Delete'))));
  }
  page($main, 'Skills', 'One private library shared by all your Bots. A good skill says when to use it, the inputs and access it needs, the steps, how to validate, what to return, and which steps need approval. A Bot may still need the app or login to use a skill.',
    h('div.row', { style: { marginBottom: '14px' } }, h('button.btn.primary', { on: { click: () => go('#/skills/new') } }, icon('plus'), 'New skill'),
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
        h('div.row', input, h('button.btn', { on: { click: () => input.value.trim() && api('POST', '/api/rules', { kind, text: input.value.trim() }).then(() => renderSettings($main, r)).catch((e) => toast(e.message, 'bad')) } }, 'Add Rule')));
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
      h('h2', 'Bot Computer'),
      h('p.hint', 'All your Bots share one computer: the workspace folder, one browser profile with your sign-ins, and this Mac’s command line. It isn’t a security boundary between Bots — use separate Tandem data folders for separate clients.'),
      h('dl.kv', h('dt', 'Workspace'), h('dd', h('code', st.workspace))),
      h('div.row', { style: { flexWrap: 'wrap' } },
        h('button.btn', { on: { click: () => { toggleComputer(true); } } }, icon('monitor'), 'Open computer'),
        h('button.btn', { on: { click: () => api('POST', '/api/computer/restart').then(() => toast('Browser restarted')) } }, icon('refresh'), 'Restart browser'),
        h('button.btn', { on: { click: () => api('POST', '/api/computer/focus') } }, icon('open'), 'Show browser window')),
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
    content = [
      h('p.hint', 'Every Bot reply, routine run and test run counts toward your Claude plan’s limits. Costs are what the API would have charged — informational on a subscription.'),
      h('dl.kv', h('dt', 'Last 7 days'), h('dd', `${u.week.turns} turns · $${u.week.cost} equivalent`)),
      h('div.list', { style: { marginTop: '12px' } }, u.byBot.map((x) => h('div.list-row', h('div.grow', x.bot || 'Deleted Bot', h('small', `${x.model} · ${x.turns} turns · ${Math.round((x.input_tokens + x.output_tokens) / 1000)}k tokens`)), h('span', `$${x.cost}`)))),
    ];
  }
  page($main, 'Settings', null, tabs, ...[content].flat());
}
