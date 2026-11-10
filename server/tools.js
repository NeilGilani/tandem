// The Tandem tools every Bot gets (served to Claude Code by mcp/tandem-mcp.js,
// implemented here). Tools that need you post a card in chat and wait.
import fs from 'node:fs';
import path from 'node:path';
import { PATHS, now } from './db.js';
import { emit } from './bus.js';
import * as chats from './chats.js';
import * as memory from './memory.js';
import * as skills from './skills.js';
import * as routines from './routines.js';
import * as connectors from './connectors.js';
import * as computer from './computer.js';
import * as vault from './vault.js';
import * as approvals from './approvals.js';
import * as mac from './mac.js';
import { CATALOG } from './catalog.js';
import * as activity from './activity.js';

let engine = null;
export const attach = (e) => { engine = e; };

const S = (props, required = []) => ({ type: 'object', properties: props, required });
const str = (description) => ({ type: 'string', description });
const bool = (description) => ({ type: 'boolean', description });
const num = (description) => ({ type: 'number', description });

export const DEFS = [
  ['approval_prompt', 'Internal: permission check for a proposed action.', S({ tool_name: str(''), input: { type: 'object' }, tool_use_id: str('') }, ['tool_name'])],
  ['remember', 'Save a lasting rule, preference, responsibility or fact to memory. Set about_user for facts about the user (shared by all Bots).',
    S({ text: str('What to remember, as one clear sentence'), about_user: bool('A fact about the user rather than about your job') }, ['text'])],
  ['forget', 'Remove memories matching text.', S({ query: str('Text of the memory to forget') }, ['query'])],
  ['recall', 'Show everything in your memory.', S({})],
  ['log_work', 'Add a dated line to your work log.', S({ text: str('What you did') }, ['text'])],
  ['list_bots', "List the user's other Bots.", S({})],
  ['message_bot', "Send an asynchronous message to another of the user's Bots. It wakes up, handles it, and (if expect_reply) its reply comes back to you.",
    S({ to: str('Bot name'), text: str('The message / task'), expect_reply: bool('Default true') }, ['to', 'text'])],
  ['list_skills', 'List skills in the shared library that are enabled for you.', S({})],
  ['get_skill', 'Load a skill by name.', S({ name: str('Skill name') }, ['name'])],
  ['save_skill', 'Save or update a skill in the shared library.',
    S({ name: str('Short name'), description: str('When to use it (Bots use this to decide)'), body: str('Markdown: when to use, inputs and access, steps, validation, output, approval points') }, ['name', 'description', 'body'])],
  ['list_routines', 'List your routines.', S({})],
  ['create_routine', 'Create a routine you own. trigger "schedule" needs a plain-language schedule; "webhook" gives a POST URL.',
    S({ name: str('Routine name'), instruction: str('What to do each run'), schedule: str('e.g. "weekdays at 8am", "every 3 hours"'), trigger: { type: 'string', enum: ['schedule', 'webhook'] } }, ['name', 'instruction'])],
  ['update_routine', 'Change a routine (name, instruction, schedule, or paused).',
    S({ id: str('Routine id'), name: str(''), instruction: str(''), schedule: str(''), paused: bool('') }, ['id'])],
  ['delete_routine', 'Delete one of your routines permanently.', S({ id: str('Routine id') }, ['id'])],
  ['test_routine', 'Run a routine now (real work).', S({ id: str('Routine id') }, ['id'])],
  ['list_connectors', 'List app connectors and their status, plus the catalog of apps that can be added.', S({})],
  ['request_connect', 'Ask the user to connect an app. Shows a Connect card and waits until it is connected or declined.', S({ app: str('App name, e.g. Gmail, Outlook, Teams, Salesforce') }, ['app'])],
  ['request_takeover', 'Hand the computer to the user for a step you cannot do (SSO, passkey, 2FA, CAPTCHA, device approval, card verification). Waits until they press I\'m done.',
    S({ reason: str('Exactly what the user needs to do') }, ['reason'])],
  ['vault_list', 'List saved Vault items (names and sites only — never values).', S({})],
  ['vault_fill_login', 'Fill a saved login into the sign-in form on the current page. You never see the values.', S({ name: str('Vault item name or site') }, ['name'])],
  ['request_secret', 'Ask the user to save a login or secret in the Vault through a masked card. Waits for it.',
    S({ name: str('Name for the item, e.g. "Salesforce login"'), site: str('Domain it is for'), username: str('Username if known'), purpose: str('Why you need it'), kind: { type: 'string', enum: ['login', 'secret'] } }, ['name', 'purpose'])],
  ['draft_message', 'Show an outgoing email/Slack/Teams/other message to the user as a draft card with Send and Discard. Do not send it yourself.',
    S({ app: str('Gmail, Outlook, Slack, Teams, LinkedIn, …'), to: str('Recipient(s) or channel'), cc: str(''), subject: str(''), body: str('Full message text'), thread: str('Thread/conversation it replies to, if any') }, ['app', 'to', 'body'])],
  ['ask_user', 'Ask the user a question (optionally with choices or a short form) and wait for the answer.',
    S({ question: str('The question'), options: { type: 'array', items: { type: 'string' }, description: 'Choices' }, fields: { type: 'array', items: { type: 'string' }, description: 'Form field labels' } }, ['question'])],
  ['add_to_library', 'Add a result (file in the workspace, page, image, video or link) to your Library.',
    S({ title: str('Title'), ref: str('Absolute file path or URL'), kind: { type: 'string', enum: ['page', 'image', 'video', 'file', 'link'] } }, ['title', 'ref'])],
  ['notify_user', 'Send the user a push notification (use sparingly).', S({ title: str(''), body: str('') }, ['body'])],
  // Mac apps (only usable when the matching app is connected)
  ['mac_calendar_events', 'Calendar (Mac): list upcoming events.', S({ days: num('Days ahead (default 7)'), calendar: str('Calendar name') })],
  ['mac_calendar_add', 'Calendar (Mac): add an event. Cannot change repeating events or send invites.', S({ title: str(''), start: str('ISO date-time'), end: str('ISO date-time'), calendar: str(''), location: str(''), notes: str('') }, ['title', 'start'])],
  ['mac_contacts_search', 'Contacts (Mac): read-only lookup.', S({ query: str('Name to search') }, ['query'])],
  ['mac_reminders_list', 'Reminders (Mac): list open reminders.', S({ list: str('List name'), includeCompleted: bool('') })],
  ['mac_reminders_add', 'Reminders (Mac): add a reminder.', S({ name: str(''), due: str('ISO date-time'), list: str(''), notes: str('') }, ['name'])],
  ['mac_reminders_complete', 'Reminders (Mac): mark reminders with this name complete.', S({ name: str('') }, ['name'])],
  ['mac_notify', 'Alarms & notifications (Mac): show a notification now or as a timer up to 24 hours ahead.', S({ title: str(''), message: str(''), inMinutes: num('Delay in minutes') }, ['message'])],
  ['mac_messages_recent', 'Messages (Mac): read recent iMessages.', S({ limit: num('') })],
].map(([name, description, inputSchema]) => ({ name, description, inputSchema }));

// ---- Cards that wait for you ---------------------------------------------------------
const waiters = new Map(); // message id -> resolve
const BACKGROUND_TTL = 30 * 60 * 1000;

function cardChat(ctx) {
  const chat = chats.getChat(ctx.chatId);
  if (chat?.kind !== 'group') return ctx.chatId;
  const dm = chats.dmFor(ctx.botId);
  chats.addMessage({ chatId: ctx.chatId, author: 'system', botId: ctx.botId, text: `${chats.getBot(ctx.botId).name} needs you in its one-to-one chat.` });
  return dm.id;
}

function waitCard(msgId, ctx) {
  return new Promise((resolve) => {
    waiters.set(msgId, resolve);
    if (ctx.origin !== 'chat') {
      setTimeout(() => {
        if (!waiters.has(msgId)) return;
        waiters.delete(msgId);
        const m = chats.getMessage(msgId);
        chats.updateMessage(msgId, { card: { ...m.card, status: 'expired' } });
        resolve({ expired: true });
      }, BACKGROUND_TTL);
    }
  });
}

function postCard(ctx, card, text = '') {
  const chatId = card.type === 'question' ? ctx.chatId : cardChat(ctx);
  const msg = chats.addMessage({ chatId, author: 'bot', botId: ctx.botId, text, card: { status: 'pending', ...card } });
  emit('notify', { botId: ctx.botId, chatId, title: chats.getBot(ctx.botId)?.name, body: card.title || card.question || card.reason || 'Needs you' });
  return msg;
}

export function resolveCard(msgId, payload) {
  const msg = chats.getMessage(msgId);
  if (!msg?.card) throw new Error('No such card');
  if (msg.card.type === 'approval') return approvals.answer(msgId, payload.choice);
  const card = { ...msg.card };
  const done = (status, value) => {
    card.status = status;
    chats.updateMessage(msgId, { card });
    const w = waiters.get(msgId);
    if (w) { waiters.delete(msgId); w(value); }
  };
  switch (card.type) {
    case 'question':
      card.answer = payload.answer;
      return done('answered', { answer: payload.answer });
    case 'secret':
      if (payload.dismiss) return done('dismissed', { dismissed: true });
      return vault.save({ name: card.name, kind: card.kind || 'login', site: card.site || '', username: payload.username || card.username || '', secret: payload.secret })
        .then((item) => done('saved', { saved: item.name }));
    case 'connect':
      if (payload.dismiss) return done('dismissed', { dismissed: true });
      return connectors.signIn(card.connectorId, { botId: msg.bot_id, chatId: msg.chat_id }).then(() => {
        card.status = 'signing-in';
        chats.updateMessage(msgId, { card });
      });
    case 'takeover':
      computer.endTakeover(msg.bot_id);
      return onTakeoverEnded(msg.bot_id).then(() => true);
    case 'draft': {
      if (msg.meta?.actId) activity.finish(msg.meta.actId, payload.action === 'discard' ? 'discarded' : 'sent');
      if (payload.action === 'discard') return done('discarded');
      const draft = { ...card, ...(payload.edits || {}) };
      Object.assign(card, payload.edits || {});
      done('sent');
      engine.runBot(msg.bot_id, msg.chat_id,
        `The user pressed Send on your ${draft.app} draft. Send it now exactly as written below, then confirm briefly.\n` +
        `To: ${draft.to}${draft.cc ? `\nCc: ${draft.cc}` : ''}${draft.subject ? `\nSubject: ${draft.subject}` : ''}${draft.thread ? `\nIn reply to: ${draft.thread}` : ''}\n\n${draft.body}`,
        { origin: 'chat', preapproved: true });
      return true;
    }
    case 'skill_draft':
      if (payload.action === 'discard') return done('discarded');
      skills.save({ name: payload.name || card.name, description: payload.description ?? card.description, body: payload.body ?? card.body });
      return done('saved');
  }
  throw new Error('Unknown card');
}

// When a takeover ends: re-check connections and release waiting Connect cards.
export async function onTakeoverEnded(botId) {
  await connectors.afterTakeover(botId);
  const status = Object.fromEntries(connectors.installed(botId).map((c) => [c.id, c.status]));
  for (const [msgId, w] of waiters) {
    const m = chats.getMessage(msgId);
    if (m?.bot_id !== botId) continue;
    if (m?.card?.type === 'takeover') {
      waiters.delete(msgId);
      chats.updateMessage(msgId, { card: { ...m.card, status: 'done' } });
      w({ done: true });
    } else if (m?.card?.type === 'connect' && m.card.status === 'signing-in') {
      const s = status[m.card.connectorId];
      if (s === 'Connected') {
        waiters.delete(msgId);
        chats.updateMessage(msgId, { card: { ...m.card, status: 'connected' } });
        w({ connected: true });
      } else {
        chats.updateMessage(msgId, { card: { ...m.card, status: 'pending', note: 'Not signed in yet — Reopen to try again.' } });
      }
    }
  }
}

function findApp(name) {
  const q = String(name).toLowerCase().replace(/[^a-z0-9]/g, '');
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  return CATALOG.find((c) => norm(c.name) === q || c.id === q)
    || CATALOG.find((c) => norm(c.name).includes(q) || q.includes(norm(c.name)));
}

// ---- Dispatcher ------------------------------------------------------------------------
export async function call(tool, args = {}, ctx) {
  const bot = chats.getBot(ctx.botId);
  if (!bot) throw new Error('Bot no longer exists');
  const isMacTool = tool.startsWith('mac_');
  if (isMacTool) {
    const app = CATALOG.find((c) => c.tools?.includes(tool));
    const ok = connectors.installed(ctx.botId).some((c) => c.catalog_id === app.id);
    if (!ok) return `${app.name} isn't connected. Call request_connect with "${app.name}" first.`;
    return mac.TOOLS[tool](args);
  }

  switch (tool) {
    case 'approval_prompt': {
      const chat = chats.getChat(ctx.chatId);
      const decisionCtx = { ...ctx, isGroup: chat?.kind === 'group' };
      if (decisionCtx.isGroup) decisionCtx.chatId = chats.dmFor(ctx.botId).id;
      return approvals.decide(args.tool_name, args.input || {}, decisionCtx);
    }
    case 'remember': {
      if (!String(args.text || '').trim()) throw new Error('Pass the fact to remember in "text".');
      const saved = memory.remember(ctx.botId, args.text, { aboutUser: !!args.about_user }).text;
      chats.addMessage({ chatId: ctx.chatId, author: 'system', botId: ctx.botId, text: `Updated memory for ${bot.name}`, meta: { kind: 'memory', fact: saved } });
      return { saved };
    }
    case 'forget': return { removed: memory.forget(ctx.botId, args.query) };
    case 'recall': return memory.recall(ctx.botId);
    case 'log_work': memory.logWork(ctx.botId, args.text); return 'Logged.';
    case 'list_bots': return chats.listBots().filter((b) => b.id !== ctx.botId).map((b) => ({ name: b.name, label: b.label }));
    case 'message_bot':
      return engine.handoff({ fromBot: ctx.botId, fromChat: ctx.chatId, to: args.to, text: args.text, expectReply: args.expect_reply !== false, depth: Number(ctx.depth || 0) });
    case 'list_skills': return skills.enabledFor(ctx.botId).map((s) => ({ name: s.name, description: s.description }));
    case 'get_skill': {
      const s = skills.read(args.name);
      if (!s) return `No skill named "${args.name}".`;
      if (!skills.enabledFor(ctx.botId).some((x) => x.slug === s.slug)) return `"${s.name}" isn't enabled for you. The user can enable it under Connect apps → Private skills.`;
      return s;
    }
    case 'save_skill': { const s = skills.save(args); return { saved: s.name }; }
    case 'list_routines':
      return routines.list(ctx.botId).map((r) => ({ id: r.id, name: r.name, when: r.when_text, paused: !!r.paused, instruction: r.instruction }));
    case 'create_routine': {
      const r = await routines.create({ botId: ctx.botId, ...args });
      const nextRun = r.next_run ? new Date(r.next_run).toLocaleString() : null;
      return { created: r.name, id: r.id, when: r.when_text, next_run: nextRun, note: 'It waits for its next scheduled time; the user can press Test to run it now.' +
        (r.trigger === 'webhook' ? ' The webhook URL and key are in the routine details on desktop.' : '') };
    }
    case 'update_routine': { const r = await routines.update(args.id, args); return { updated: r.name, when: r.when_text, paused: !!r.paused }; }
    case 'delete_routine': routines.remove(args.id); return 'Deleted.';
    case 'test_routine': return routines.start(args.id, { test: true });
    case 'list_connectors':
      return { connected: connectors.installed(ctx.botId).map((c) => ({ name: c.name, status: c.status })), catalog: CATALOG.map((c) => c.name) };
    case 'request_connect': {
      const app = findApp(args.app);
      if (!app) return `"${args.app}" isn't in the catalog. The user can add any MCP server as a custom app under Connect apps.`;
      const row = connectors.add(app.id);
      const c = connectors.installed(ctx.botId).find((x) => x.id === row.id);
      if (c.status === 'Connected') return `${app.name} is connected.`;
      const msg = postCard(ctx, { type: 'connect', connectorId: c.id, name: app.name, color: app.color, title: `Connect ${app.name}` }, '');
      const res = await waitCard(msg.id, ctx);
      return res.connected ? `${app.name} is connected. Continue.` : res.expired ? 'The Connect card expired.' : `The user didn't connect ${app.name}.`;
    }
    case 'request_takeover': {
      const msg = postCard(ctx, { type: 'takeover', reason: args.reason, title: 'Take over the computer' });
      computer.startTakeover({ reason: args.reason, botId: ctx.botId, chatId: msg.chat_id });
      computer.bringToFront(ctx.botId).catch(() => {});
      const res = await waitCard(msg.id, ctx);
      if (res.expired && computer.machine(ctx.botId).control === 'user') computer.endTakeover(ctx.botId);
      return res.expired ? 'Nobody took over within 30 minutes. Report that this step needs the user.' : 'The user pressed I\'m done. Continue from the current page.';
    }
    case 'vault_list': return vault.list().map(({ name, kind, site, username }) => ({ name, kind, site, has_username: !!username }));
    case 'vault_fill_login': {
      const item = vault.find(args.name);
      if (!item) return `Nothing named "${args.name}" in the Vault. Call request_secret to ask the user to save it.`;
      const page = (await computer.pages(ctx.botId))[0];
      const host = page ? new URL(page.url).hostname : '';
      if (item.site && !host.endsWith(item.site.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, ''))) {
        return `Refused: "${item.name}" is saved for ${item.site}, but the current page is ${host}.`;
      }
      const secret = await vault.reveal(item.id);
      const filled = await computer.fillLogin(ctx.botId, item.username, secret);
      return filled ? `Filled ${filled}. Submit the form to continue.` : 'No login fields found on this page.';
    }
    case 'request_secret': {
      const msg = postCard(ctx, { type: 'secret', name: args.name, site: args.site || '', username: args.username || '', purpose: args.purpose, kind: args.kind || 'login', title: `Save ${args.name} to Vault` });
      const res = await waitCard(msg.id, ctx);
      return res.saved ? `Saved "${res.saved}" in the Vault. Use vault_fill_login on the sign-in page.` : res.expired ? 'The request expired.' : 'The user declined.';
    }
    case 'draft_message': {
      const dm = postCard(ctx, { type: 'draft', app: args.app, to: args.to, cc: args.cc || '', subject: args.subject || '', body: args.body, thread: args.thread || '', title: `${args.app} draft` });
      const actId = activity.log({ runId: ctx.runId, botId: ctx.botId, chatId: dm.chat_id, kind: 'draft', tool: 'draft_message', summary: `${args.app} draft to ${args.to}${args.subject ? `: ${args.subject}` : ''}`, detail: args.body, status: 'pending', origin: ctx.origin });
      chats.updateMessage(dm.id, { meta: { ...(dm.meta || {}), actId } });
      return 'The draft is shown to the user with Send and Discard. Do not send it yourself. If they press Send, you will be asked to send it.';
    }
    case 'ask_user': {
      const msg = postCard(ctx, { type: 'question', question: args.question, options: args.options || [], fields: args.fields || [] });
      const res = await waitCard(msg.id, ctx);
      return res.expired ? 'No answer within 30 minutes.' : { answer: res.answer };
    }
    case 'add_to_library': {
      let kind = args.kind;
      if (!kind) kind = /^https?:/.test(args.ref) ? 'link' : /\.(png|jpe?g|gif|webp)$/i.test(args.ref) ? 'image' : /\.(mp4|mov|webm)$/i.test(args.ref) ? 'video' : /\.(md|html?)$/i.test(args.ref) ? 'page' : 'file';
      if (!/^https?:/.test(args.ref) && !fs.existsSync(args.ref)) {
        const p = [computer.workspaceOf(ctx.botId), PATHS.shared].map((d) => path.join(d, args.ref)).find((x) => fs.existsSync(x)) || path.join(computer.workspaceOf(ctx.botId), args.ref);
        if (!fs.existsSync(p)) return `No file at ${args.ref}`;
        args.ref = p;
      }
      chats.addToLibrary({ botId: ctx.botId, kind, title: args.title, ref: args.ref });
      chats.addMessage({ chatId: ctx.chatId, author: 'bot', botId: ctx.botId, card: { type: 'file', status: 'done', kind, title: args.title, ref: args.ref } });
      return 'Added to your Library.';
    }
    case 'notify_user':
      emit('notify', { botId: ctx.botId, chatId: ctx.chatId, title: args.title || bot.name, body: args.body });
      return 'Sent.';
  }
  throw new Error(`Unknown tool ${tool}`);
}

// ---- Teach a task → draft skill ------------------------------------------------------
export async function draftSkillFromTeach(t) {
  const frames = t.frames;
  const step = Math.max(1, Math.ceil(frames.length / 40));
  const sample = frames.filter((_, i) => i % step === 0 || i === frames.length - 1);
  const timeline = sample.map((f) => `${(f.at / 1000).toFixed(0)}s  ${f.url}  — ${f.title}  [${f.file}]`).join('\n');
  const prompt = `The user demonstrated a browser task so it can be saved as a reusable skill.\nIntended result: ${t.goal}\n\n` +
    `Screenshots were taken every 2 seconds. Read the image files below in order with the Read tool, work out what they did, then write the skill.\n\n${timeline}\n\n` +
    'Reply with JSON only: {"name":"short name","description":"when to use it","body":"Markdown with sections: When to use, Inputs and access needed, Steps, Validation, What to return, Approval needed before"}';
  const { spawn } = await import('node:child_process');
  const { CLAUDE_BIN, childEnv } = await import('./claude.js');
  const out = await new Promise((resolve, reject) => {
    const child = spawn(CLAUDE_BIN, ['-p', prompt, '--model', 'sonnet', '--output-format', 'json', '--tools', 'Read', '--allowedTools', 'Read',
      '--setting-sources', '', '--strict-mcp-config', '--no-session-persistence', '--add-dir', t.dir], { cwd: t.dir, env: childEnv() });
    let o = '', e = '';
    child.stdout.on('data', (d) => (o += d));
    child.stderr.on('data', (d) => (e += d));
    child.on('close', () => { try { resolve(JSON.parse(o).result); } catch { reject(new Error(e || 'Could not draft the skill')); } });
  });
  const m = String(out).match(/\{[\s\S]*\}/);
  const j = m ? JSON.parse(m[0]) : { name: t.goal.slice(0, 40), description: t.goal, body: String(out) };
  return j;
}
