// Tandem daemon: HTTP API + live events + the web app, on http://127.0.0.1:4747.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ROOT, PATHS, all, get, run, uid, now, setting, setSetting, timezone } from './db.js';
import { subscribe, emit } from './bus.js';
import * as chats from './chats.js';
import * as engine from './engine.js';
import * as tools from './tools.js';
import * as approvals from './approvals.js';
import * as connectors from './connectors.js';
import * as computer from './computer.js';
import * as skills from './skills.js';
import * as routines from './routines.js';
import * as memory from './memory.js';
import * as vault from './vault.js';
import { TEMPLATES } from './templates.js';
import { CATEGORIES } from './catalog.js';

const PORT = Number(process.env.PORT || 4747);
const HOST = process.argv.includes('--lan') || process.env.TANDEM_LAN ? '0.0.0.0' : '127.0.0.1';
engine.setPort(PORT);
tools.attach(engine);
routines.attach(engine);

const WEB = path.join(ROOT, 'web');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.pdf': 'application/pdf',
  '.md': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.csv': 'text/csv', '.mp4': 'video/mp4', '.webm': 'video/webm', '.webmanifest': 'application/manifest+json' };

// ---- helpers -----------------------------------------------------------------------
const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
const readBody = (req, limit = 30 << 20) => new Promise((resolve, reject) => {
  const chunks = []; let n = 0;
  req.on('data', (c) => { n += c.length; if (n > limit) { reject(new Error('Too large')); req.destroy(); } else chunks.push(c); });
  req.on('end', () => resolve(Buffer.concat(chunks)));
  req.on('error', reject);
});
const readJson = async (req) => { const b = await readBody(req); return b.length ? JSON.parse(b.toString()) : {}; };

function isLocal(req) {
  const a = req.socket.remoteAddress || '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}
function authed(req) {
  const token = setting('access_token');
  const h = req.headers.authorization || '';
  if (h === `Bearer ${token}`) return true;
  const cookie = (req.headers.cookie || '').split(/;\s*/).find((c) => c.startsWith('tandem_token='));
  if (cookie && cookie.slice(13) === token) return true;
  return false;
}

function serveFile(res, file, extraHeaders = {}) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return json(res, 404, { error: 'Not found' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Content-Length': st.size, ...extraHeaders });
    fs.createReadStream(file).pipe(res);
  });
}

function insideAllowed(p) {
  const real = path.resolve(p);
  return [PATHS.computers, PATHS.shared, PATHS.uploads, PATHS.teach].some((root) => real === root || real.startsWith(root + path.sep));
}

function lanUrls() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) for (const i of list || []) if (i.family === 'IPv4' && !i.internal) out.push(`http://${i.address}:${PORT}`);
  return out;
}

function stateSnapshot() {
  return {
    bots: chats.listBots(),
    chats: chats.listChats().map((c) => ({ ...c, last: lastPreview(c.id) })),
    sections: all('SELECT * FROM sections ORDER BY position'),
    runs: engine.activeRuns(),
    computers: computer.statusAll(),
    connectors: connectors.installed().map(({ id, catalog_id, name, status, color, category, kind }) => ({ id, catalog_id, name, status, color, category, kind })),
    settings: publicSettings(),
  };
}

function lastPreview(chatId) {
  const m = get("SELECT author, bot_id, text, card, created FROM messages WHERE chat_id = ? AND author != 'system' ORDER BY created DESC LIMIT 1", chatId);
  if (!m) return null;
  let text = m.text;
  if (!text && m.card) { try { const c = JSON.parse(m.card); text = c.summary || c.title || c.question || c.reason || ''; } catch {} }
  return { author: m.author, bot_id: m.bot_id, text: String(text || '').replace(/[`*#>_]+/g, '').slice(0, 140), created: m.created };
}

function publicSettings() {
  return {
    auto_review: setting('auto_review') === '1',
    timezone: setting('timezone'),
    resolved_timezone: timezone(),
    local_execution: setting('local_execution'),
    theme: setting('theme'),
    user_name: setting('user_name') || os.userInfo().username,
    rules: approvals.rules(),
    lan: HOST === '0.0.0.0',
    lan_urls: HOST === '0.0.0.0' ? lanUrls().map((u) => `${u}/?token=${setting('access_token')}`) : [],
    workspace: PATHS.computers,
    shared: PATHS.shared,
  };
}

// ---- router ------------------------------------------------------------------------
const routes = [];
const route = (method, pattern, handler) => {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, handler });
};

// State & events
route('GET', '/api/state', () => stateSnapshot());
route('GET', '/api/events', (req, res) => { subscribe(res); return undefined; });
route('GET', '/api/search', (req, res, p, q) => chats.search(q.get('q') || ''));

// Bots
route('POST', '/api/bots', async (req) => {
  const b = chats.createBot(await readJson(req));
  return { bot: b, chat: chats.dmFor(b.id) };
});
route('PATCH', '/api/bots/:id', async (req, res, p) => chats.updateBot(p.id, await readJson(req)));
route('DELETE', '/api/bots/:id', async (req, res, p) => {
  for (const r of engine.activeRuns().filter((x) => x.botId === p.id)) engine.stop(r.id, { silent: true });
  await computer.closeBrowser(p.id).catch(() => {});
  run('DELETE FROM connector_status WHERE bot_id = ?', p.id);
  chats.deleteBot(p.id); return { ok: true };
});
route('POST', '/api/bots/:id/primary', (req, res, p) => { chats.setPrimary(p.id); return { ok: true }; });
route('POST', '/api/bots/:id/duplicate', (req, res, p) => { const b = chats.duplicateBot(p.id); return { bot: b, chat: chats.dmFor(b.id) }; });
route('GET', '/api/bots/:id/library', (req, res, p) => chats.library(p.id));
route('GET', '/api/bots/:id/memory', (req, res, p) => memory.recall(p.id));
route('POST', '/api/bots/:id/avatar', async (req, res, p) => {
  const buf = await readBody(req, 25 << 20);
  const type = req.headers['content-type'] || 'image/png';
  return chats.updateBot(p.id, { avatar: `data:${type};base64,${buf.toString('base64')}` });
});
route('GET', '/api/bots/:id/routines', (req, res, p) => routines.list(p.id).map((r) => ({
  ...r, runs: routines.runsOf(r.id), webhook_url: r.trigger === 'webhook' ? `http://${req.headers.host}/hooks/${r.id}` : null,
})));
route('POST', '/api/bots/:id/routines', async (req, res, p) => routines.create({ botId: p.id, ...(await readJson(req)) }));

// Templates
route('GET', '/api/templates', () => TEMPLATES);
route('POST', '/api/templates/:id/import', (req, res, p) => {
  const t = TEMPLATES.find((x) => x.id === p.id);
  if (!t) throw new Error('No such template');
  const b = chats.createBot({ name: t.name, label: t.label, color: t.color, shape: t.shape, template: t.id });
  for (const j of t.job) memory.remember(b.id, j);
  memory.remember(b.id, `Apps this job usually needs: ${t.apps.join(', ')}. Ask to connect them with request_connect when a task needs one.`);
  return { bot: b, chat: chats.dmFor(b.id) };
});

// Chats & messages
route('POST', '/api/chats', async (req) => chats.createGroup(await readJson(req)));
route('PATCH', '/api/chats/:id', async (req, res, p) => chats.updateChat(p.id, await readJson(req)));
route('DELETE', '/api/chats/:id', (req, res, p) => { engine.stopChat(p.id); chats.deleteChat(p.id); return { ok: true }; });
route('GET', '/api/chats/:id/messages', (req, res, p, q) => ({
  messages: chats.messages(p.id, { before: Number(q.get('before')) || undefined }),
  runs: engine.runningIn(p.id),
}));
route('POST', '/api/chats/:id/messages', async (req, res, p) => {
  const body = await readJson(req);
  const text = String(body.text || '').trim();
  if (!text && !body.attachments?.length) throw new Error('Empty message');
  if (/^stop( now)?[.!]*$/i.test(text)) {
    const m = chats.addMessage({ chatId: p.id, author: 'user', text });
    engine.stopChat(p.id);
    return m;
  }
  const msg = chats.addMessage({ chatId: p.id, author: 'user', text, parentId: body.parentId || null, attachments: body.attachments || [] });
  engine.onUserMessage(p.id, msg).catch((e) => console.error('run', e));
  return msg;
});
route('POST', '/api/chats/:id/stop', (req, res, p) => { engine.stopChat(p.id); return { ok: true }; });
route('POST', '/api/chats/:id/reset', (req, res, p) => { engine.stopChat(p.id); chats.resetChat(p.id); return { ok: true }; });
route('POST', '/api/messages/:id/react', async (req, res, p) => chats.react(p.id, (await readJson(req)).emoji));
route('POST', '/api/cards/:id', async (req, res, p) => ({ ok: await tools.resolveCard(p.id, await readJson(req)) }));

// Uploads (attachments)
route('POST', '/api/uploads', async (req) => {
  const name = path.basename(decodeURIComponent(req.headers['x-filename'] || 'file')).replace(/[^\w.\- ]/g, '_');
  const dir = path.join(PATHS.uploads, uid());
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, await readBody(req));
  return { name, path: file, type: req.headers['content-type'] || '' };
});

// Connect apps
route('GET', '/api/connectors', (req, res, p, q) => { const b = q.get('bot') || chats.primaryBot()?.id || null; return { bot: b, catalog: connectors.catalogWithStatus(b), installed: connectors.installed(b), categories: CATEGORIES }; });
route('POST', '/api/connectors', async (req) => connectors.add((await readJson(req)).catalogId));
route('POST', '/api/connectors/custom', async (req) => ({ id: connectors.addCustom(await readJson(req)) }));
route('POST', '/api/connectors/refresh', async (req, res, p, q) => { const b = q.get('bot'); await connectors.refresh(b || undefined); return connectors.installed(b); });
route('POST', '/api/connectors/:id/signin', async (req, res, p, q) => connectors.signIn(p.id, { botId: botParam(q, await readJson(req)) }));
route('POST', '/api/connectors/:id/connected', async (req, res, p, q) => { connectors.markConnected(botParam(q, await readJson(req)), p.id); return { ok: true }; });
route('DELETE', '/api/connectors/:id', async (req, res, p) => { await connectors.remove(p.id); return { ok: true }; });

// Skills
route('GET', '/api/skills', () => ({
  skills: skills.list(),
  disabled: all('SELECT * FROM skill_disabled'),
}));
route('GET', '/api/skills/:slug', (req, res, p) => skills.read(p.slug));
route('POST', '/api/skills', async (req) => skills.save(await readJson(req)));
route('PUT', '/api/skills/:slug', async (req, res, p) => skills.save({ ...(await readJson(req)), slug: p.slug }));
route('DELETE', '/api/skills/:slug', (req, res, p) => { skills.remove(p.slug); return { ok: true }; });
route('POST', '/api/skills/:slug/enabled', async (req, res, p) => { const b = await readJson(req); skills.setEnabled(b.botId, p.slug, b.on); return { ok: true }; });

// Routines
route('PATCH', '/api/routines/:id', async (req, res, p) => routines.update(p.id, await readJson(req)));
route('DELETE', '/api/routines/:id', (req, res, p) => { routines.remove(p.id); return { ok: true }; });
route('POST', '/api/routines/:id/test', (req, res, p) => routines.start(p.id, { test: true }));
route('POST', '/api/routines/:id/rotate', (req, res, p) => routines.rotateSecret(p.id));
route('POST', '/api/schedule/preview', async (req) => routines.interpret((await readJson(req)).text));

// Settings
route('GET', '/api/settings', () => publicSettings());
route('PATCH', '/api/settings', async (req) => {
  const b = await readJson(req);
  if (b.auto_review != null) setSetting('auto_review', b.auto_review ? '1' : '0');
  if (b.timezone) { setSetting('timezone', b.timezone); routines.recomputeAll(); }
  if (b.local_execution && ['ask', 'always', 'never'].includes(b.local_execution)) setSetting('local_execution', b.local_execution);
  if (b.theme) setSetting('theme', b.theme);
  if (b.user_name != null) setSetting('user_name', String(b.user_name).trim().slice(0, 60));
  emit('settings');
  return publicSettings();
});
route('POST', '/api/rules', async (req) => { const b = await readJson(req); return { id: approvals.addRule(b.kind, b.text) }; });
route('DELETE', '/api/rules/:id', (req, res, p) => { approvals.removeRule(p.id); return { ok: true }; });
route('POST', '/api/memory/import', async (req) => {
  const { text } = await readJson(req);
  const primary = chats.primaryBot();
  if (!primary) throw new Error('Create a primary Bot first');
  return { imported: memory.importMemory(primary.id, text), bot: primary.name };
});
route('GET', '/api/usage', () => ({
  byBot: all(`SELECT b.name AS bot, u.model, count(*) AS turns, round(sum(u.cost), 4) AS cost, sum(u.input_tokens) AS input_tokens, sum(u.output_tokens) AS output_tokens
    FROM usage u LEFT JOIN bots b ON b.id = u.bot_id WHERE u.created > ? GROUP BY u.bot_id, u.model ORDER BY cost DESC`, now() - 7 * 864e5),
  week: get('SELECT count(*) AS turns, round(coalesce(sum(cost),0), 4) AS cost FROM usage WHERE created > ?', now() - 7 * 864e5),
}));

// Vault
route('GET', '/api/vault', () => vault.list());
route('POST', '/api/vault', async (req) => vault.save(await readJson(req)));
route('DELETE', '/api/vault/:id', async (req, res, p) => { await vault.remove(p.id); return { ok: true }; });

// Computers (one per Bot). Every route takes ?bot=<id> or { botId }.
const botParam = (q, body = {}) => {
  const id = body.botId || q?.get?.('bot');
  if (!id || !chats.getBot(id)) throw new Error('Choose a Bot');
  return id;
};
route('GET', '/api/computer/status', () => computer.statusAll());
route('GET', '/api/computer/screenshot', async (req, res, p, q) => {
  const id = q.get('bot');
  const shot = id ? await computer.screenshot(id).catch(() => null) : null;
  if (!shot) return json(res, 503, { error: 'This Bot’s computer isn’t running' });
  const buf = Buffer.from(shot.data, 'base64');
  res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store', 'X-Page-Url': encodeURIComponent(shot.url || ''),
    'X-Page-Title': encodeURIComponent(shot.title || ''), 'X-Viewport': `${shot.width}x${shot.height}` });
  res.end(buf);
});
route('POST', '/api/computer/start', async (req, res, p, q) => { const id = botParam(q, await readJson(req)); await computer.ensureBrowser(id); return computer.status(id); });
route('POST', '/api/computer/takeover', async (req, res, p, q) => {
  const b = await readJson(req);
  const id = botParam(q, b);
  await computer.ensureBrowser(id);
  computer.startTakeover({ botId: id, reason: b.reason || 'You took control' });
  if (b.focus) await computer.bringToFront(id);
  return computer.status(id);
});
route('POST', '/api/computer/done', async (req, res, p, q) => {
  const id = botParam(q, await readJson(req));
  computer.endTakeover(id);
  await tools.onTakeoverEnded(id);
  return computer.status(id);
});
route('POST', '/api/computer/input', async (req, res, p, q) => {
  const b = await readJson(req);
  const id = botParam(q, b);
  if (computer.machine(id).control !== 'user') throw new Error('Take control first');
  return { ok: await computer.input(id, b) };
});
route('POST', '/api/computer/open', async (req, res, p, q) => { const b = await readJson(req); await computer.openUrl(botParam(q, b), b.url); return { ok: true }; });
route('POST', '/api/computer/focus', async (req, res, p, q) => { const id = botParam(q, await readJson(req)); await computer.ensureBrowser(id); await computer.bringToFront(id); return { ok: true }; });
route('POST', '/api/computer/restart', async (req, res, p, q) => { const id = botParam(q, await readJson(req)); await computer.restartBrowser(id); return computer.status(id); });
route('POST', '/api/computer/teach/start', async (req) => {
  const b = await readJson(req);
  const t = await computer.startTeach({ chatId: b.chatId, botId: botParam(null, b), goal: b.goal });
  return { id: t.id };
});
route('POST', '/api/computer/teach/stop', async (req, res, p, q) => {
  const body = await readJson(req);
  const id = body.botId || q.get('bot') || computer.teaching()?.botId;
  const t = id && computer.stopTeach(id);
  if (!t) throw new Error('Not recording');
  if (!t.frames.length) { chats.addMessage({ chatId: t.chatId, author: 'system', text: 'Recording stopped. Nothing was captured.' }); return { ok: true }; }
  const note = chats.addMessage({ chatId: t.chatId, author: 'system', botId: t.botId, text: 'Drafting a skill from what you showed it' });
  tools.draftSkillFromTeach(t).then((d) => {
    chats.updateMessage(note.id, { text: 'Skill drafted from what you showed it' });
    chats.addMessage({ chatId: t.chatId, author: 'bot', botId: t.botId, card: { type: 'skill_draft', status: 'pending', name: d.name, description: d.description, body: d.body, title: `Draft skill: ${d.name}` } });
  }).catch((e) => chats.addMessage({ chatId: t.chatId, author: 'system', text: `Couldn't draft the skill: ${e.message}` }));
  return { ok: true };
});

// Files from the workspace / uploads (for Library and attachments)
route('GET', '/files', (req, res, p, q) => {
  const f = q.get('path') || '';
  if (!insideAllowed(f)) return json(res, 403, { error: 'Outside the computer workspace' });
  serveFile(res, f, q.get('download') ? { 'Content-Disposition': `attachment; filename="${path.basename(f)}"` } : {});
});

// Webhook triggers (authorized by the routine's own key)
route('POST', '/hooks/:id', async (req, res, p) => {
  let payload = null;
  try { payload = await readJson(req); } catch { payload = null; }
  const r = routines.webhook(p.id, req.headers.authorization, payload);
  res.writeHead(r.status, { 'Content-Type': 'text/plain' });
  res.end(r.body);
});

// Internal (the per-run MCP bridge)
route('GET', '/internal/tools', () => tools.DEFS);
route('POST', '/internal/call', async (req) => {
  const { tool, args, ctx } = await readJson(req);
  return { result: await tools.call(tool, args, ctx) };
});

// ---- server ------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;

  // First visit from a phone: ?token=… sets a cookie.
  const qtoken = url.searchParams.get('token');
  if (qtoken && qtoken === setting('access_token')) {
    res.writeHead(302, { 'Set-Cookie': `tandem_token=${qtoken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`, Location: '/' });
    return res.end();
  }

  const isHook = p.startsWith('/hooks/');
  const isInternal = p.startsWith('/internal/');
  if (isInternal && !authed(req)) return json(res, 401, { error: 'Unauthorized' });
  if (!isHook && !isInternal && !isLocal(req) && !authed(req)) {
    res.writeHead(401, { 'Content-Type': 'text/html' });
    return res.end('<p style="font:16px system-ui;padding:2rem">Open the link from Tandem → Settings → Devices on this phone.</p>');
  }
  // Same-origin guard for state-changing requests from browsers.
  if (req.method !== 'GET' && !isHook && !isInternal) {
    const origin = req.headers.origin;
    if (origin && new URL(origin).host !== req.headers.host) return json(res, 403, { error: 'Cross-origin request blocked' });
  }

  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = p.match(r.re);
    if (!m) continue;
    const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
    try {
      const out = await r.handler(req, res, params, url.searchParams);
      if (out !== undefined && !res.headersSent) json(res, 200, out);
    } catch (e) {
      if (!res.headersSent) json(res, 400, { error: e.message });
    }
    return;
  }

  if (req.method === 'GET' && !p.startsWith('/api/')) {
    const file = path.join(WEB, p === '/' ? 'index.html' : path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
    if (file.startsWith(WEB) && fs.existsSync(file) && fs.statSync(file).isFile()) return serveFile(res, file);
    return serveFile(res, path.join(WEB, 'index.html'));
  }
  json(res, 404, { error: 'Not found' });
});
server.requestTimeout = 0;
server.headersTimeout = 0;
server.keepAliveTimeout = 65000;

// Computer ↔ Connect apps: re-check sign-ins every few minutes.
setInterval(() => connectors.refresh().catch(() => {}), 3 * 60 * 1000);
computer.startIdleReaper((botId) => engine.activeRuns().some((r) => r.botId === botId));
// Routine scheduler.
routines.recomputeAll();
setInterval(() => routines.tick(), 20 * 1000);
// Stale per-run MCP configs from a previous crash.
for (const f of fs.readdirSync(PATHS.runtime)) if (f.startsWith('mcp-')) fs.rmSync(path.join(PATHS.runtime, f), { force: true });

server.listen(PORT, HOST, async () => {
  console.log(`Tandem is running at http://127.0.0.1:${PORT}`);
  if (HOST === '0.0.0.0') for (const u of lanUrls()) console.log(`  on your network: ${u}/?token=${setting('access_token')}`);
  const migrated = await computer.migrateLegacy(chats.primaryBot()?.id).catch((e) => { console.log(`  migration: ${e.message}`); return null; });
  if (migrated) {
    connectors.migrateLegacy(migrated.primaryBotId);
    console.log('  moved the shared computer: sign-ins went to your primary Bot, files to the Shared folder');
  }
  console.log('  each Bot gets its own computer when it starts work');
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => {
  for (const r of engine.activeRuns()) engine.stop(r.id, { silent: true });
  process.exit(0);
});
