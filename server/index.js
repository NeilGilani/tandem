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
import * as activity from './activity.js';
import { CLAUDE_BIN, childEnv } from './claude.js';
import * as toolbox from './toolbox.js';
import * as squads from './squads.js';
import * as laptop from './laptop.js';
import * as accounts from './accounts.js';
import * as gmail from './gmail.js';
import * as command from './command.js';
import * as members from './members.js';
import * as workday from './workday.js';
import * as company from './company.js';
import * as office from './office.js';
import * as missions from './missions.js';
import { MACHINE, findChrome, keepAwake } from './platform.js';
import { WHERE as SECRETS_WHERE } from './secrets.js';
import { CATEGORIES } from './catalog.js';

const PORT = Number(process.env.PORT || 4747);
const HOST = process.argv.includes('--lan') || process.env.TANDEM_LAN || setting('network_access') === '1' ? '0.0.0.0' : '127.0.0.1';
engine.setPort(PORT);
tools.attach(engine);
routines.attach(engine);
missions.attach(engine);
squads.attach(engine);
company.attach(engine);
office.attach(engine);
command.attach(engine);
workday.attach(engine);
engine.onRunEnd(({ opts, text, error, stopped }) => { if (opts.taskId && !error && !stopped && text) command.closeIfOpen(opts.taskId, text); });

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
  // Anything relayed through a proxy (tailscale serve, a tunnel) is not this Mac.
  if (req.headers['x-forwarded-for'] || req.headers['tailscale-user-login'] || req.headers['cf-connecting-ip']) return false;
  const a = req.socket.remoteAddress || '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}
const reqToken = (req) => {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return h.slice(7);
  const cookie = (req.headers.cookie || '').split(/;\s*/).find((c) => c.startsWith('tandem_token='));
  return cookie ? cookie.slice(13) : '';
};
// You (this Mac, or your own link) or a teammate with theirs.
function whoIs(req) {
  const m = members.fromToken(reqToken(req));
  if (m) return { ...m, owner: false };
  if (isLocal(req) || authed(req)) return members.owner(setting('user_name') || os.userInfo().username);
  return null;
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
    helpers: chats.listHelpers(),
    squads: squads.list(12).map(squads.publicSquad),
    chats: chats.listChats().map((c) => ({ ...c, last: lastPreview(c.id) })),
    sections: all('SELECT * FROM sections ORDER BY position'),
    runs: engine.activeRuns(),
    computers: computer.statusAll(),
    pending: pendingCards(),
    missions: missions.list().filter((m) => !['stopped'].includes(m.status) || Date.now() - m.updated < 864e5).slice(0, 40),
    connectors: connectors.installed().map(({ id, catalog_id, name, status, color, category, kind }) => ({ id, catalog_id, name, status, color, category, kind })),
    settings: publicSettings(),
  };
}

// Everything waiting on you, across all chats (approvals, drafts, questions, sign-ins).
const NEEDS_YOU = new Set(['approval', 'draft', 'question', 'secret', 'connect', 'takeover', 'skill_draft', 'hire', 'gmail_connect']);
function pendingCards() {
  return all(`SELECT * FROM messages WHERE card IS NOT NULL AND card LIKE '%"status":"pending"%' ORDER BY created DESC LIMIT 100`)
    .map(chats.parseMsg).filter((m) => m.card && m.card.status === 'pending' && NEEDS_YOU.has(m.card.type));
}

function lastPreview(chatId) {
  const m = get("SELECT author, bot_id, text, card, created FROM messages WHERE chat_id = ? AND author != 'system' ORDER BY created DESC LIMIT 1", chatId);
  if (!m) return null;
  let text = m.text;
  if (!text && m.card) { try { const c = JSON.parse(m.card); text = c.summary || c.title || c.question || c.reason || ''; } catch {} }
  return { author: m.author, bot_id: m.bot_id, text: String(text || '').replace(/[`*#>_]+/g, '').slice(0, 140), created: m.created };
}

function publicSettings(who = { owner: true }) {
  return {
    billing: members.billing(),
    platform: process.platform,
    machine: MACHINE,
    secrets_where: SECRETS_WHERE,
    auto_review: setting('auto_review') === '1',
    toolbox: toolbox.status().state,
    draft_reviews: setting('draft_reviews') === '1',
    company_name: setting('company_name') || '',
    gmail_email: setting('gmail_email') || '',
    computer_mode: laptop.enabled() ? 'laptop' : 'mac',
    laptops: laptop.status(),
    laptop_folders: (() => { try { return JSON.parse(setting('laptop_folders') || '[]'); } catch { return []; } })(),
    timezone: setting('timezone'),
    resolved_timezone: timezone(),
    local_execution: setting('local_execution'),
    theme: setting('theme'),
    user_name: setting('user_name') || os.userInfo().username,
    usage_guard: setting('usage_guard') !== '0',
    usage_guard_at: Number(setting('usage_guard_at') || 0.9),
    routine_model: setting('routine_model') || 'balanced',
    onboarded: setting('onboarded') === '1',
    plan: activity.plan(),
    rules: approvals.rules(),
    lan: HOST === '0.0.0.0',
    lan_urls: HOST === '0.0.0.0' && who.owner ? lanUrls().map((u) => `${u}/?token=${setting('access_token')}`) : [],
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
route('GET', '/api/state', (req) => ({ ...stateSnapshot(), settings: publicSettings(req.who), me: req.who, members: members.list() }));
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
  const by = req.who.owner ? {} : { by: { id: req.who.id, name: req.who.name, role: req.who.role } };
  const msg = chats.addMessage({ chatId: p.id, author: 'user', text, parentId: body.parentId || null, attachments: body.attachments || [], meta: { ...(body.voice ? { voice: true } : {}), ...by } });
  const chatRow = chats.getChat(p.id);
  if (chatRow?.kind === 'dm') missions.onUserMessage(p.id, chatRow.bot_ids[0]);
  engine.onUserMessage(p.id, msg).catch((e) => console.error('run', e));
  return msg;
});
route('GET', '/api/company', () => ({ name: company.companyName(), org: company.org(), tasks: company.tasks(), reports: company.reportsFor(), timesheet: company.timesheet(),
  shifts: missions.list().filter((m) => ['active', 'waiting', 'blocked'].includes(m.status)).map((m) => ({ botId: m.bot_id, hours: m.hours, title: m.title, status: m.status })),
  worked: all("SELECT bot_id, created, ended FROM actions WHERE kind = 'run' AND created > ?", Date.now() - 864e5) }));
route('PATCH', '/api/company', async (req) => { const b = await readJson(req); if (b.name !== undefined) setSetting('company_name', String(b.name).slice(0, 60)); if (b.draft_reviews !== undefined) setSetting('draft_reviews', b.draft_reviews ? '1' : '0'); emit('company'); return { ok: true }; });
route('PATCH', '/api/company/bots/:id', async (req, res, p) => { const b = company.setRole(p.id, await readJson(req)); office.ensureChannels(); return b; });
route('GET', '/api/office', () => ({
  channels: office.channels().map((c) => ({ id: c.id, name: c.name, members: c.bot_ids, last: office.recent(c.id, 6) })),
  meetings: office.meetings(), goals: office.goals(), handbook: office.handbook(), handbookPath: office.handbookPath(),
}));
route('POST', '/api/office/channels', () => office.ensureChannels().map((c) => c.name));
route('POST', '/api/office/meetings', async (req) => { const b = await readJson(req); return office.schedule({ title: b.title, chairId: b.chairId, attendees: b.attendees || [], agenda: b.agenda, when: b.when, rounds: b.rounds }); });
route('POST', '/api/office/meetings/:id/run', (req, res, p) => { office.runMeeting(p.id); return { ok: true }; });
route('DELETE', '/api/office/meetings/:id', (req, res, p) => { office.removeMeeting(p.id); return { ok: true }; });
route('POST', '/api/office/goals', async (req) => office.setGoal({ ...(await readJson(req)), by: 'user' }));
route('PATCH', '/api/office/goals/:id', async (req, res, p) => { const b = await readJson(req); return b.current !== undefined && Object.keys(b).length <= 2 ? office.updateGoal(p.id, { current: b.current, note: b.note, by: 'user' }) : office.setGoal({ ...b, id: p.id, by: 'user' }); });
route('PUT', '/api/office/handbook', async (req) => { const b = await readJson(req); return { ok: office.updateHandbook('user', b.section, b.text) }; });
route('POST', '/api/office/reviews', () => ({ bosses: office.runReviews() }));
route('POST', '/api/company/tasks', async (req) => { const b = await readJson(req); return company.assign({ title: b.title, detail: b.detail, ownerId: b.ownerId, due: b.due, assignedBy: 'user' }); });
route('PATCH', '/api/company/tasks/:id', async (req, res, p) => { const b = await readJson(req); return b.verdict ? company.review(p.id, { verdict: b.verdict, notes: b.notes, by: 'user' }) : company.update(p.id, { status: b.status, note: b.note, by: 'user' }); });
route('POST', '/api/command', async (req) => command.ask((await readJson(req)).text, req.who));
route('GET', '/api/command/feed', () => command.feed());
route('GET', '/api/gmail', () => ({ connected: gmail.connected(), email: gmail.email() }));
route('POST', '/api/gmail', async (req) => gmail.connect(await readJson(req)));
route('DELETE', '/api/gmail', async () => { await gmail.disconnect(); return { ok: true }; });
route('GET', '/api/accounts', () => accounts.list().map((a) => ({ ...a, source: chats.getBot(a.source_bot)?.name || null })));
route('PATCH', '/api/accounts/:key', async (req, res, p) => { const b = await readJson(req); accounts.setShared(decodeURIComponent(p.key), b.shared); return { ok: true }; });
route('DELETE', '/api/accounts/:key', async (req, res, p) => { await accounts.forget(decodeURIComponent(p.key)); return { ok: true }; });
route('POST', '/api/squads/:id/stop', (req, res, p) => ({ ok: squads.stop(p.id) }));
route('POST', '/api/chats/:id/warm', (req, res, p) => ({ ok: engine.warm(p.id) }));
route('POST', '/api/chats/:id/stop', (req, res, p) => { engine.stopChat(p.id); return { ok: true }; });
route('POST', '/api/chats/:id/reset', (req, res, p) => { engine.stopChat(p.id); chats.resetChat(p.id); return { ok: true }; });
route('POST', '/api/messages/:id/react', async (req, res, p) => chats.react(p.id, (await readJson(req)).emoji));
route('POST', '/api/cards/:id', async (req, res, p) => {
  const payload = await readJson(req);
  const msg = chats.getMessage(p.id);
  if (msg?.card && !members.canResolve(req.who, msg.card, payload)) throw new Error(msg.card.type === 'draft' ? `Only ${members.ownerFirst()} can send from their accounts. You can skip it.` : `Only ${members.ownerFirst()} can answer this one.`);
  return { ok: await tools.resolveCard(p.id, payload) };
});

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

// Missions
route('GET', '/api/missions', (req, res, p, q) => missions.list(q.get('bot') || undefined));
route('GET', '/api/missions/:id', (req, res, p) => missions.getMission(p.id));
route('POST', '/api/missions', async (req) => {
  const b = await readJson(req);
  return missions.create({ botId: b.botId, title: b.title, goal: b.goal, doneWhen: b.doneWhen || '', hours: b.hours || 'any', dailyBudget: b.dailyBudget || 12 });
});
route('PATCH', '/api/missions/:id', async (req, res, p) => missions.update(p.id, await readJson(req)));
route('POST', '/api/missions/:id/pause', (req, res, p) => missions.pause(p.id));
route('POST', '/api/missions/:id/resume', (req, res, p) => missions.resume(p.id));
route('POST', '/api/missions/:id/stop', (req, res, p) => missions.stop(p.id));
route('POST', '/api/missions/:id/now', (req, res, p) => { const m = missions.getMission(p.id); if (missions.isBusy(m.bot_id)) throw new Error('This Bot is busy right now'); missions.runSession(m); return { ok: true }; });
route('DELETE', '/api/missions/:id', (req, res, p) => { missions.remove(p.id); return { ok: true }; });

// Settings
route('GET', '/api/settings', (req) => publicSettings(req.who));
route('PATCH', '/api/settings', async (req) => {
  const b = await readJson(req);
  if (b.auto_review != null) setSetting('auto_review', b.auto_review ? '1' : '0');
  if (b.timezone) { setSetting('timezone', b.timezone); routines.recomputeAll(); }
  if (b.local_execution && ['smart', 'ask', 'always', 'never'].includes(b.local_execution)) setSetting('local_execution', b.local_execution);
  if (b.computer_mode && ['laptop', 'mac'].includes(b.computer_mode)) setSetting('computer_mode', b.computer_mode);
  if (Array.isArray(b.laptop_folders)) {
    setSetting('laptop_folders', JSON.stringify(b.laptop_folders.map(String).filter((f) => path.isAbsolute(f)).slice(0, 20)));
    // Laptops pick up new folders on their next start; running ones restart when idle.
    laptop.foldersChanged();
    for (const bt of chats.listBots()) if (!engine.activeRuns().some((r) => r.botId === bt.id)) laptop.remove(bt.id);
    laptop.prepare();
  }
  if (b.theme) setSetting('theme', b.theme);
  if (b.user_name != null) setSetting('user_name', String(b.user_name).trim().slice(0, 60));
  if (b.usage_guard != null) setSetting('usage_guard', b.usage_guard ? '1' : '0');
  if (b.usage_guard_at != null) setSetting('usage_guard_at', String(Math.min(Math.max(Number(b.usage_guard_at) || 0.9, 0.5), 1)));
  if (b.routine_model && ['balanced', 'economy'].includes(b.routine_model)) setSetting('routine_model', b.routine_model);
  if (b.onboarded != null) setSetting('onboarded', b.onboarded ? '1' : '0');
  emit('settings');
  return publicSettings();
});
// Teammates (owner only) and who pays for Bot work
const linksFor = (token) => (HOST === '0.0.0.0' ? lanUrls().map((u) => `${u}/?token=${token}`) : []);
route('GET', '/api/members', () => ({ members: members.list(), lan: HOST === '0.0.0.0' }));
route('POST', '/api/members', async (req) => { const r = members.add(await readJson(req)); return { member: r.member, links: linksFor(r.token), lan: HOST === '0.0.0.0' }; });
route('POST', '/api/members/:id/link', (req, res, p) => { const r = members.relink(p.id); return { member: r.member, links: linksFor(r.token), lan: HOST === '0.0.0.0' }; });
route('DELETE', '/api/members/:id', (req, res, p) => { members.revoke(p.id); return { ok: true }; });
// Let other computers (teammates, your phone) reach Tandem. Takes a restart; the Mac app restarts itself.
route('POST', '/api/network', async (req) => {
  const on = !!(await readJson(req)).on;
  setSetting('network_access', on ? '1' : '0');
  const auto = !!process.env.TANDEM_APP; // the Mac and Windows apps restart the server themselves
  if (auto && (HOST === '0.0.0.0') !== on) setTimeout(() => process.exit(0), 400);
  return { on, restarting: auto, needsRestart: !auto && (HOST === '0.0.0.0') !== on };
});
route('GET', '/api/billing', () => members.billing());
route('POST', '/api/billing', async (req) => members.setBilling(await readJson(req)));
route('POST', '/api/rules', async (req) => { const b = await readJson(req); return { id: approvals.addRule(b.kind, b.text) }; });
route('DELETE', '/api/rules/:id', (req, res, p) => { approvals.removeRule(p.id); return { ok: true }; });
route('POST', '/api/memory/import', async (req) => {
  const { text } = await readJson(req);
  const primary = chats.primaryBot();
  if (!primary) throw new Error('Create a primary Bot first');
  return { imported: memory.importMemory(primary.id, text), bot: primary.name };
});
route('GET', '/api/activity', (req, res, p, q) => {
  const day = q.get('day'); // YYYY-MM-DD in local time
  let since = Number(q.get('since')) || undefined, until;
  if (day) { const d = new Date(`${day}T00:00:00`); since = d.getTime(); until = since + 864e5; }
  return { items: activity.list({ botId: q.get('bot') || undefined, since, until, kind: q.get('kind') || undefined, q: q.get('q') || undefined }), plan: activity.plan() };
});
// Setup checks for the first-run screen: Claude Code signed in, and a browser available.
route('GET', '/api/health', async () => {
  const { execFile } = await import('node:child_process');
  const claude = await new Promise((resolve) => execFile(CLAUDE_BIN, ['auth', 'status'], { timeout: 15000, env: childEnv() }, (err, out) => {
    if (err && !out) return resolve({ installed: false, loggedIn: false });
    try { const j = JSON.parse(out); resolve({ installed: true, loggedIn: !!j.loggedIn, method: j.authMethod }); } catch { resolve({ installed: true, loggedIn: false }); }
  }));
  const chrome = !!findChrome();
  return { claude, chrome, node: process.versions.node };
});
route('GET', '/api/plan', () => ({ plan: activity.plan(), guard: activity.routinesShouldWait() }));
route('GET', '/api/usage', () => ({
  plan: activity.plan(),
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
  if (qtoken && (qtoken === setting('access_token') || members.fromToken(qtoken))) {
    res.writeHead(302, { 'Set-Cookie': `tandem_token=${qtoken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`, Location: '/' });
    return res.end();
  }

  const isHook = p.startsWith('/hooks/');
  const isInternal = p.startsWith('/internal/');
  if (isInternal && !authed(req)) return json(res, 401, { error: 'Unauthorized' });
  req.who = isHook || isInternal ? null : whoIs(req);
  if (!isHook && !isInternal && !req.who) {
    res.writeHead(401, { 'Content-Type': 'text/html' });
    return res.end('<p style="font:16px system-ui;padding:2rem">Open the link from Tandem → Settings → Devices on this phone.</p>');
  }
  // Same-origin guard for state-changing requests from browsers.
  if (req.method !== 'GET' && !isHook && !isInternal) {
    const origin = req.headers.origin;
    if (origin && new URL(origin).host !== req.headers.host) return json(res, 403, { error: 'Cross-origin request blocked' });
  }
  if (req.who && !req.who.owner && members.ownerOnly(req.method, p)) return json(res, 403, { error: `Only ${members.ownerFirst()} can change this.` });

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
    // App files revalidate every load, so an update never leaves stale screens behind.
    const fresh = { 'Cache-Control': 'no-cache' };
    if (file.startsWith(WEB) && fs.existsSync(file) && fs.statSync(file).isFile()) return serveFile(res, file, /\/logos\//.test(file) ? {} : fresh);
    return serveFile(res, path.join(WEB, 'index.html'), fresh);
  }
  json(res, 404, { error: 'Not found' });
});
server.requestTimeout = 0;
server.headersTimeout = 0;
server.keepAliveTimeout = 65000;

// Computer ↔ Connect apps: re-check sign-ins every few minutes.
setInterval(() => connectors.refresh().catch(() => {}), 3 * 60 * 1000);
setInterval(() => activity.prune(), 6 * 3600 * 1000);
// Missions: wake Bots on schedule, and resume what was due while Tandem was off.
missions.recover();
toolbox.ensure(); // shared Python for Bots, built once in the background
squads.recover();
setInterval(() => company.tickDraftReviews(), 5 * 60e3);
setInterval(() => office.tickMeetings(), 30e3);
setInterval(() => office.tickReviews(), 30 * 60e3);
if (company.org().some((o) => o.reports.length)) office.ensureChannels();
// Company sign-ins: every Bot's computer gets them when it wakes; keep them fresh.
accounts.onRefresh((botId) => connectors.refresh(botId));
if (accounts.list().some((a) => a.key === 'google.com')) accounts.forget('google.com'); // shared Google sessions get signed out
computer.onBrowserStart((botId) => accounts.applyAll(botId));
accounts.startKeepFresh(connectors.isConnected);
// First start on laptops: sign-ins from the old Mac browsers come along (once).
if (laptop.enabled() && !setting('accounts_imported')) {
  const connected = all(`SELECT s.bot_id, c.catalog_id FROM connector_status s JOIN connectors c ON c.id = s.connector_id WHERE s.status = 'Connected'`);
  accounts.importFromMac(connected).then((n) => { setSetting('accounts_imported', '1'); if (n) console.log(`moved ${n} sign-in(s) to company accounts`); })
    .catch((e) => console.error('import sign-ins', e.message))
    .finally(() => computer.closeMacBrowsers(all('SELECT id FROM bots').map((b) => b.id)));
}
if (laptop.enabled()) laptop.prepare(); // Bot laptops: start the VM, build the image once
await members.loadApiKey().catch(() => {});
routines.recover();
setInterval(() => missions.tick(), 15 * 1000);
// Keep the computer from idle-sleeping while Bots work or a mission wakes soon (the lid still sleeps it).
let caffeinate = null;
setInterval(() => {
  const need = engine.activeRuns().length > 0 || missions.needsAwake();
  if (need && !caffeinate) {
    caffeinate = keepAwake();
    if (caffeinate) { const c = caffeinate; c.on('error', () => {}); c.on('exit', () => { if (caffeinate === c) caffeinate = null; }); }
  } else if (!need && caffeinate) { caffeinate.kill(); caffeinate = null; }
}, 20 * 1000);
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
