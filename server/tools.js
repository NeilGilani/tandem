// The Tandem tools every Bot gets (served to Claude Code by mcp/tandem-mcp.js,
// implemented here). Tools that need you post a card in chat and wait.
import fs from 'node:fs';
import path from 'node:path';
import { PATHS, now, all } from './db.js';
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
import * as missions from './missions.js';
import * as squads from './squads.js';
import * as laptop from './laptop.js';
import * as accounts from './accounts.js';
import * as company from './company.js';
import * as office from './office.js';
import * as gmail from './gmail.js';
import * as workday from './workday.js';

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
  ['message_bot', "Message a teammate. During work sessions it lands in their inbox and they handle it in their next session (their reply comes to your inbox); don't wait for it. When the user is chatting with you, it's delivered right away.",
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
  ['ask_user', "Ask when you're stuck. In a chat with the user, it asks them and waits. During work sessions it goes to your boss (or to the user if it's truly their call) and you DON'T wait: move on to other work; the answer arrives in your inbox.",
    S({ question: str('The question'), options: { type: 'array', items: { type: 'string' }, description: 'Choices' }, fields: { type: 'array', items: { type: 'string' }, description: 'Form field labels' } }, ['question'])],
  ['add_to_library', 'Add a result (file in the workspace, page, image, video or link) to your Library.',
    S({ title: str('Title'), ref: str('Absolute file path or URL'), kind: { type: 'string', enum: ['page', 'image', 'video', 'file', 'link'] } }, ['title', 'ref'])],
  ['start_mission', 'Start a long-running mission you own until it is done: for work that takes hours or days, many steps, or waiting on other people. Confirm the goal and done criteria with the user first unless they already gave them.',
    S({ title: str('Short title'), goal: str('The outcome, in the user\'s terms'), done_when: str('Concrete, checkable criteria for done'), hours: str('"any" (default), "weekdays 9-18" or "daily 8-22"'), daily_sessions: num('Max work sessions per day (default 12)') }, ['title', 'goal'])],
  ['set_mission_plan', 'Save your mission plan as a Markdown checklist ("- [ ] step", "- [x] done step"). Keep it current: check items off as you finish them, add new ones as you learn more.',
    S({ plan: str('The full plan as a Markdown checklist') }, ['plan'])],
  ['mission_checkpoint', 'End a mission work session. Record what you did and decide what happens next: continue right away, wait until a time, blocked on the user, or done.',
    S({ note: str('What you did this session and where you left off (your future self reads this)'), next: { type: 'string', enum: ['continue', 'wait', 'blocked', 'done'] },
      wait_until: str('ISO date-time to wake up, when next="wait"'), wait_reason: str('What you will do when you wake up'), blocked_reason: str('What you need from the user, when next="blocked"'), summary: str('Final summary of results, when next="done"') }, ['note', 'next'])],
  ['gmail_search', "Search the user's Gmail with Gmail search syntax (from:, to:, subject:, is:unread, newer_than:7d, in:inbox, has:attachment…). Returns id, sender, subject, date, unread and a snippet. Works for every Bot at once; never open Gmail in the browser.",
    S({ query: str('Gmail search, e.g. "in:inbox is:unread newer_than:2d"'), limit: num('Max results (default 15, up to 50)') })],
  ['gmail_read', 'Read one email in full by its id from gmail_search: sender, recipients, subject, text, attachments and the Message-ID to reply to.', S({ id: num('Email id') }, ['id'])],
  ['gmail_update', 'Organize an email by id: archive it, mark it read or unread, star it, or add or remove a label.',
    S({ id: num('Email id'), archive: bool(''), read: bool(''), star: bool(''), add_label: str(''), remove_label: str('') }, ['id'])],
  ['team_status', "See what every Bot on the team is doing right now: who is working and on what step, their current mission and plan progress, open assignments, and their last few actions. Use it instead of asking teammates for a status.", S({})],
  ['discard_draft', 'Drop one of your own drafts that is no longer needed (by recipient). The user stops seeing it.', S({ to: str('The recipient of the draft to drop') }, ['to'])],
  ['post_to_channel', 'Post in a team channel (like #general or your department channel): updates, wins, questions for the team, blockers. @Name a teammate to get their reply in the channel.',
    S({ channel: str('Channel name, e.g. #sales'), text: str('The message') }, ['channel', 'text'])],
  ['read_channel', 'Read the latest messages in a team channel.', S({ channel: str('Channel name'), limit: num('How many (default 20)') }, ['channel'])],
  ['list_goals', 'See the goals scoreboard: company, department and personal goals with their current numbers.', S({})],
  ['update_goal', 'Update the current number on a goal you own, from a real source, with a short note on what changed.', S({ id: str('Goal id'), current: num('The new current value'), note: str('What changed and where the number comes from') }, ['id', 'current'])],
  ['set_goal', 'Leads only: create or change a goal for your team (title, target number, unit, due date, owner, and how it is measured).',
    S({ id: str('Goal id to change (omit to create)'), title: str(''), target: num(''), unit: str('e.g. ranches, intros, grants'), due: str('YYYY-MM-DD'), owner: str('Bot name who owns it'), parent_id: str('The bigger goal it rolls up to'), how: str('How the number is measured') })],
  ['schedule_meeting', 'Leads only: set up a recurring meeting (or a one-off with no schedule) that you chair. Attendees talk in turns and you close it with decisions and assignments.',
    S({ title: str(''), attendees: { type: 'array', items: { type: 'string' }, description: 'Bot names' }, when: str('e.g. "Mondays at 9:30am" (leave empty to run it now)'), agenda: str('') }, ['title', 'attendees'])],
  ['write_review', "Your monthly review of one of your direct reports: a 1 to 5 rating, what went well, what to improve, and one concrete coaching change (saved to their memory).",
    S({ bot: str('Report name'), rating: num('1 to 5'), went_well: str(''), improve: str(''), coaching: str('One specific change to how they work') }, ['bot', 'rating', 'coaching'])],
  ['update_handbook', 'Leads only: write or replace a section of the company handbook, the source of truth every Bot follows (pricing, product facts, outreach style, rules).',
    S({ section: str('Section name, e.g. Pricing'), text: str('The full section, in Markdown') }, ['section', 'text'])],
  ['assign_task', 'Give one of your direct reports an assignment (you are their boss). They are woken to work on it and submit it back to you for review.',
    S({ to: str('Bot name'), title: str('Short title of the assignment'), detail: str('Exactly what to do and what to hand back'), due: str('Due date, e.g. 2026-11-14 (optional)') }, ['to', 'title'])],
  ['list_tasks', 'List your open assignments, and the ones waiting for your review.', S({})],
  ['update_task', 'Record progress on one of your assignments: status (todo, doing, blocked) and a short note.', S({ id: str('Assignment id'), status: { type: 'string', enum: ['todo', 'doing', 'blocked'] }, note: str('') }, ['id'])],
  ['submit_task', 'Hand in a finished assignment with the result (what you did, where the files are). It goes to your boss for review.', S({ id: str('Assignment id'), result: str('The result and file paths') }, ['id', 'result'])],
  ['review_task', "Review an assignment one of your reports submitted: approve it, or send it back with clear notes on what to fix.", S({ id: str('Assignment id'), verdict: { type: 'string', enum: ['approve', 'send_back'] }, notes: str('') }, ['id', 'verdict'])],
  ['review_draft', "Decide on a routine draft one of your reports wrote. approve sends it right away (you may fix subject or body first); send_back returns it with notes.",
    S({ card_id: str('The draft card id from the review request'), verdict: { type: 'string', enum: ['approve', 'send_back'] }, notes: str('What you changed, or what they should fix'), subject: str('Fixed subject (optional)'), body: str('Fixed body (optional)') }, ['card_id', 'verdict'])],
  ['answer_teammate', "Answer a question one of your reports asked you (id from your inbox). Decide it yourself; that's your job as their boss.",
    S({ id: str('Question id from your inbox'), answer: str('Your decision, in a line or two') }, ['id', 'answer'])],
  ['escalate_to_neil', "Pass a report's question to the founder because only they can decide it (money, signing, investors, first impressions with important people, hiring, legal, direction). Not for anything you can decide.",
    S({ id: str('Question id from your inbox'), note: str('One line of context or your recommendation') }, ['id'])],
  ['post_report', 'Post your standup (start of your shift: yesterday, today, blockers) or end-of-day report (shipped, open, blocked). Your boss and Neil see it on the Company page.',
    S({ kind: { type: 'string', enum: ['standup', 'eod'] }, text: str('Three or four short lines') }, ['kind', 'text'])],
  ['request_hire', 'Ask Neil to hire a new Bot onto your team, when there is more steady work in your area than you and your reports can do. Neil approves or declines.',
    S({ title: str('Job title, e.g. Prospecting rep'), why: str('The work they would own and why now'), name: str('Suggested name (optional)') }, ['title', 'why'])],
  ['desktop_screenshot', "See your laptop's whole screen (1280 by 800): the desktop, every open window and app, not just the browser page. Use it before clicking on the desktop.", S({})],
  ['desktop', "Use your laptop's desktop with the mouse and keyboard, for desktop apps (LibreOffice spreadsheets, documents and slides, the file manager, the terminal window). For websites, use the browser tools instead. Returns a fresh screenshot. action: click, double_click, move, drag (to x2,y2), scroll (amount, negative is up), type (text), key (keys like ctrl+s or Return), open (app: browser, terminal, files, spreadsheet, document, slides, editor, optionally a file path).",
    S({ action: { type: 'string', enum: ['click', 'double_click', 'move', 'drag', 'scroll', 'type', 'key', 'open'] }, x: num('Screen x'), y: num('Screen y'), x2: num(''), y2: num(''), amount: num(''), text: str(''), keys: str('xdotool key names, space separated'), app: str(''), file: str('Absolute path to open with the app'), button: str('left or right') }, ['action'])],
  ['start_squad', 'Split a big job into independent parts that helper Bots do at the same time, each on its own computer (a copy of yours, with your sign-ins). Use it when the work divides cleanly and each part takes real effort: research many companies, find leads in several places, check many sites, draft many personal emails. Not for quick tasks or steps that depend on each other. Returns right away: end your turn with one short line, and you will be woken with every part\'s result to check, merge and deliver.',
    S({ goal: str('The overall outcome, in the user\'s terms'), parts: { type: 'array', description: '2 to 8 self-contained parts', items: S({ title: str('Short name for the part'), task: str('Exactly what to do and what to produce, so a helper can do it alone') }, ['title', 'task']) },
      merge: str('How the parts should be combined at the end, e.g. "one sheet with all leads" (optional)') }, ['goal', 'parts'])],
  ['site_fetch', "Call a website's own data URLs with your browser's sign-in (cookies and session), without clicking through pages. For bulk reads like a whole inbox, sheet, CRM list or report: find the URLs the page itself loads with browser_network_requests, then fetch them here and page through with their cursor or offset. The full response is saved to a file in your working folder; you get a preview. GET is read-only; other methods ask the user first unless it's a GraphQL query.",
    S({ url: str('Full URL'), method: str('GET (default), POST, PUT, PATCH or DELETE'), headers: { type: 'object', description: 'Extra request headers (e.g. a CSRF token or x-requested-with the site expects)' },
      body: str('Request body, for POST and the like'), save_as: str('File name in your working folder for the full response (optional)') }, ['url'])],
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
  if (!chat || chat.kind === 'dm') return ctx.chatId;
  const dm = chats.dmFor(ctx.botId);
  if (chat.kind === 'group') chats.addMessage({ chatId: ctx.chatId, author: 'system', botId: ctx.botId, text: `${chats.getBot(ctx.botId).name} needs you in its one-to-one chat.` });
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
  if (card.status !== 'review') emit('notify', { botId: ctx.botId, chatId, title: chats.getBot(ctx.botId)?.name, body: card.title || card.question || card.reason || 'Needs you' });
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
    case 'gmail_connect':
      return gmail.connect({ address: payload.address, appPassword: payload.appPassword }).then((r) => { card.email = r.email; done('connected', { connected: true }); return true; });
    case 'hire': {
      if (payload.decline) { done('declined', {}); engine.runInOffice(card.boss, `[Neil declined hiring a ${card.role}]${payload.note ? ` ${payload.note}` : ''}`, { origin: 'handoff' }).catch(() => {}); return true; }
      const nb = chats.createBot({ name: (payload.name || card.name || card.role).trim(), label: card.role });
      company.setRole(nb.id, { title: card.role, bossId: card.boss });
      memory.remember(nb.id, `My job (hired ${new Date().toISOString().slice(0, 10)}): ${card.role}, reporting to ${chats.getBot(card.boss)?.name}. ${card.why}`);
      card.hired = nb.id;
      done('hired', { botId: nb.id });
      engine.runInOffice(card.boss, `[Neil approved the hire] ${nb.name} (${card.role}) now reports to you. Give them their first assignment with assign_task.`, { origin: 'handoff' }).catch(() => {});
      return true;
    }
    case 'question':
      card.answer = payload.answer;
      if (card.async) workday.deliver({ to: msg.bot_id, from: 'user', kind: 'answer', text: String(payload.answer), ref: card.question });
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
      if (card.async) { done('done'); workday.deliver({ to: msg.bot_id, from: 'user', kind: 'message', text: `Done with the step you needed: ${card.reason}. Your browser is yours again.` }); }
      return onTakeoverEnded(msg.bot_id).then(() => true);
    case 'draft': {
      if (msg.meta?.actId) activity.finish(msg.meta.actId, payload.action === 'discard' ? 'discarded' : 'sent');
      if (payload.action === 'discard') return done('discarded');
      const draft = { ...card, ...(payload.edits || {}) };
      Object.assign(card, payload.edits || {});
      // Email with Gmail connected: Tandem sends it through Gmail itself, right away.
      if (gmail.connected() && /gmail|e-?mail|^mail$/i.test(draft.app || 'Email') && /@/.test(draft.to || '')) {
        return (async () => {
          const inReplyTo = draft.thread ? await gmail.replyTarget(draft.thread, draft.to).catch(() => null) : null;
          await gmail.send({ to: draft.to, cc: draft.cc, subject: draft.subject, body: draft.body, inReplyTo });
          card.sentAt = now();
          done('sent');
          activity.log({ botId: msg.bot_id, chatId: msg.chat_id, kind: 'tool', tool: 'gmail_send', summary: `Sent email to ${draft.to}`, detail: draft.subject || '', status: 'ok', origin: 'chat' });
          return true;
        })();
      }
      done('sent');
      const approver = card.approvedBy;
      engine.runBot(msg.bot_id, approver ? chats.officeFor(msg.bot_id).id : msg.chat_id,
        `${approver ? `${approver}, your boss, approved your ${draft.app} draft.` : `The user pressed Send on your ${draft.app} draft.`} Send it now exactly as written below, then confirm briefly. If you can't send it, say exactly why.\n` +
        `To: ${draft.to}${draft.cc ? `\nCc: ${draft.cc}` : ''}${draft.subject ? `\nSubject: ${draft.subject}` : ''}${draft.thread ? `\nIn reply to: ${draft.thread}` : ''}\n\n${draft.body}`,
        { origin: approver ? 'handoff' : 'chat', preapproved: true });
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
// A website's own data, fetched with the Bot's sign-in. Big responses go to a file.
async function siteFetch(args, ctx) {
  const url = String(args.url || '');
  let u; try { u = new URL(url); } catch { throw new Error('Pass a full URL, starting with https://'); }
  if (!/^https?:$/.test(u.protocol)) throw new Error('Only http and https URLs');
  const method = String(args.method || 'GET').toUpperCase();
  const body = args.body == null ? null : typeof args.body === 'string' ? args.body : JSON.stringify(args.body);
  const readOnly = /^(GET|HEAD|OPTIONS)$/.test(method) || (method === 'POST' && /^\s*\{?\s*"?(query|operationName)"?/.test(body || '') && !/\bmutation\b/.test(body || ''));
  if (!readOnly) {
    const chat = chats.getChat(ctx.chatId);
    const dctx = { ...ctx, isGroup: chat?.kind === 'group', chatId: chat && chat.kind !== 'dm' ? chats.dmFor(ctx.botId).id : ctx.chatId };
    const v = await approvals.confirm('site_fetch', { url, method, body: (body || '').slice(0, 2000) }, dctx,
      { summary: `${method} to ${u.host} with your sign-in`, url, warnings: [method === 'DELETE' ? "This can't be undone" : 'This changes data on that site'] });
    if (v.behavior !== 'allow') return v.message || 'The user denied this request.';
  }
  const r = await computer.siteFetch(ctx.botId, { url, method, headers: args.headers || {}, body });
  const dir = path.join(computer.workspaceOf(ctx.botId), args.save_as ? '' : '.site');
  const json = /json/.test(r.type) || /^\s*[[{]/.test(r.text.slice(0, 50));
  const name = args.save_as ? path.basename(String(args.save_as)) : `${u.host}-${Date.now()}.${json ? 'json' : /html/.test(r.type) ? 'html' : 'txt'}`;
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, r.text);
  let shape = '';
  if (json) {
    try {
      const j = JSON.parse(r.text.replace(/^\)\]\}'[^\n]*\n/, ''));
      const describeShape = (v, d = 0) => Array.isArray(v) ? `array(${v.length})${v.length && d < 2 ? ` of ${describeShape(v[0], d + 1)}` : ''}`
        : v && typeof v === 'object' ? (d > 2 ? 'object' : `{${Object.keys(v).slice(0, 25).map((k) => `${k}: ${describeShape(v[k], d + 1)}`).join(', ')}}`) : typeof v;
      shape = describeShape(j);
    } catch {}
  }
  return [`${method} ${r.url} → ${r.status} (${r.type || 'unknown type'}, ${r.text.length.toLocaleString()} characters)`,
    `Saved to ${file}`, shape && `Shape: ${shape.slice(0, 1500)}`, `Preview:\n${r.text.slice(0, shape ? 1500 : 3000)}`].filter(Boolean).join('\n');
}

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
    case 'site_fetch': return siteFetch(args, ctx);
    case 'gmail_search': if (!gmail.connected()) return 'Gmail is not connected yet. Call request_connect with "Gmail".'; return gmail.search(args.query || 'in:inbox', args.limit);
    case 'gmail_read': if (!gmail.connected()) return 'Gmail is not connected yet. Call request_connect with "Gmail".'; return gmail.read(args.id);
    case 'gmail_update': if (!gmail.connected()) return 'Gmail is not connected yet.'; return gmail.update(args.id, { archive: args.archive, read: args.read, star: args.star, addLabel: args.add_label, removeLabel: args.remove_label });
    case 'team_status': {
      const runs = engine.activeRuns();
      const ms = missions.list();
      return chats.listBots().map((b) => {
        const r = runs.find((x) => x.botId === b.id && !x.squadId);
        const m = ms.find((x) => x.bot_id === b.id && ['active', 'waiting', 'blocked'].includes(x.status));
        const t = company.tasks({ ownerId: b.id, open: true });
        const recent = activity.list({ botId: b.id, since: now() - 864e5 }).filter((a) => ['run', 'draft', 'task', 'handoff'].includes(a.kind)).slice(0, 4).map((a) => a.summary);
        const plan = m?.plan ? `${(m.plan.match(/^\s*[-*] \[x\]/gim) || []).length}/${(m.plan.match(/^\s*[-*] \[[ x]\]/gim) || []).length} steps` : '';
        return `${b.name}${b.title ? ` (${b.title})` : ''}: ${r ? `WORKING now: ${r.status}` : 'idle'}${m ? `; mission "${m.title}" ${m.status}${plan ? `, ${plan}` : ''}${m.status === 'waiting' && m.wake_reason ? ` (next: ${m.wake_reason})` : ''}${m.status === 'blocked' && m.block_reason ? ` (blocked: ${m.block_reason})` : ''}` : ''}${t.length ? `; assignments: ${t.map((x) => x.title).slice(0, 3).join('; ')}` : ''}${recent.length ? `; recently: ${recent.join(' | ')}` : ''}`;
      }).join('\n');
    }
    case 'discard_draft': {
      const norm = (x) => String(x || '').toLowerCase().replace(/\s+/g, '');
      const list = all(`SELECT * FROM messages WHERE bot_id = ? AND card LIKE '%"type":"draft"%' ORDER BY created DESC LIMIT 100`, ctx.botId)
        .map(chats.parseMsg).filter((m) => ['pending', 'review', 'returned'].includes(m.card?.status) && norm(m.card.to) === norm(args.to));
      for (const m of list) chats.updateMessage(m.id, { card: { ...m.card, status: 'discarded' } });
      return list.length ? `Dropped ${list.length} draft${list.length === 1 ? '' : 's'} to ${args.to}.` : `You have no open draft to ${args.to}.`;
    }
    case 'post_to_channel': office.post(ctx.botId, args.channel, args.text || args.message, Number(ctx.depth || 0)); return `Posted in ${args.channel}.`;
    case 'read_channel': { const c = office.channelByName(args.channel); if (!c) return `No channel ${args.channel}. Channels: ${office.channels().map((x) => x.name).join(', ')}`; return office.recent(c.id, Math.min(Number(args.limit) || 20, 60)) || '(no messages yet)'; }
    case 'list_goals': return office.scoreboard() || 'No goals yet.';
    case 'update_goal': { const g = office.getGoal(args.id); if (!g) throw new Error('No such goal. Use list_goals for ids.'); return office.updateGoal(args.id, { current: args.current, note: args.note, by: ctx.botId }); }
    case 'set_goal': return office.setGoal({ id: args.id, title: args.title, target: args.target, unit: args.unit, due: args.due, how: args.how, parentId: args.parent_id || null, ownerId: args.owner ? chats.findBot(args.owner)?.id || null : null, by: ctx.botId });
    case 'schedule_meeting': {
      if (!/chief|head|lead|manager/i.test(chats.getBot(ctx.botId)?.title || '') && !company.reportsOf(ctx.botId).length) throw new Error('Only leads set up meetings. Ask your boss.');
      const ids = (args.attendees || []).map((n) => chats.findBot(n)?.id).filter(Boolean);
      const mt = await office.schedule({ title: args.title, chairId: ctx.botId, attendees: ids, agenda: args.agenda, when: args.when });
      if (!args.when) setTimeout(() => office.runMeeting(mt.id), 1500);
      return mt.schedule_text ? `Scheduled "${mt.title}" ${mt.schedule_text}.` : `"${mt.title}" starts now in its meeting room.`;
    }
    case 'write_review': return office.writeReview(ctx.botId, args);
    case 'update_handbook': return office.updateHandbook(ctx.botId, args.section, args.text);
    case 'assign_task': return company.assign({ title: args.title, detail: args.detail, ownerId: args.to, assignedBy: ctx.botId, due: args.due });
    case 'list_tasks': return { mine: company.tasks({ ownerId: ctx.botId, open: true }).map(({ id, title, status, due, notes }) => ({ id, title, status, due, lastNote: notes?.at(-1)?.text })),
      toReview: company.tasks({ open: true }).filter((t) => t.reviewer_id === ctx.botId && t.status === 'review').map(({ id, title, owner_id, result }) => ({ id, title, from: chats.getBot(owner_id)?.name, result })) };
    case 'update_task': { const t = company.getTask(args.id); if (!t || t.owner_id !== ctx.botId) throw new Error('That assignment is not yours.'); company.update(args.id, { status: args.status, note: args.note, by: ctx.botId }); return 'Updated.'; }
    case 'submit_task': { const t = company.getTask(args.id); if (!t || t.owner_id !== ctx.botId) throw new Error('That assignment is not yours.'); return company.submit(args.id, { result: args.result, by: ctx.botId }); }
    case 'review_task': return company.review(args.id, { verdict: args.verdict, notes: args.notes, by: ctx.botId });
    case 'review_draft': {
      const m = chats.getMessage(args.card_id);
      if (!m?.card || m.card.type !== 'draft' || m.card.status !== 'review') return 'That draft is not waiting for review.';
      if (company.bossOf(m.bot_id)?.id !== ctx.botId) return 'Only the writer\'s boss reviews this draft.';
      const me = chats.getBot(ctx.botId).name;
      if (args.verdict === 'approve' && m.card.routine) {
        chats.updateMessage(m.id, { card: { ...m.card, status: 'pending', reviewedBy: me, reviewNote: args.notes || null, approvedBy: me } });
        await resolveCard(m.id, { action: 'send', edits: { ...(args.subject ? { subject: args.subject } : {}), ...(args.body ? { body: args.body } : {}) } });
        const direct = gmail.connected() && /@/.test(m.card.to || '');
        activity.log({ botId: ctx.botId, kind: 'decision', summary: `Approved ${chats.getBot(m.bot_id)?.name}'s email to ${m.card.to}`, detail: m.card.subject || '', status: 'ok', origin: 'company' });
        return direct ? `Approved and sent to ${m.card.to}.` : `Approved. ${chats.getBot(m.bot_id)?.name} is sending it now.`;
      }
      if (args.verdict === 'approve') {
        chats.updateMessage(m.id, { card: { ...m.card, status: 'pending', ...(args.subject ? { subject: args.subject } : {}), ...(args.body ? { body: args.body } : {}), reviewedBy: me, reviewNote: args.notes || null } });
        emit('notify', { botId: m.bot_id, chatId: m.chat_id, title: 'Draft ready for you', body: `${chats.getBot(m.bot_id)?.name}'s draft to ${m.card.to}, reviewed by ${me}` });
        return 'Approved. It is in Neil\'s inbox now.';
      }
      chats.updateMessage(m.id, { card: { ...m.card, status: 'returned', reviewedBy: me, reviewNote: args.notes || '' } });
      workday.deliver({ to: m.bot_id, from: ctx.botId, kind: 'draft_back', text: `To: ${m.card.to}${m.card.subject ? `, "${m.card.subject}"` : ''}. Notes: ${args.notes || '(none)'}. Fix it and draft again if it's still needed.` });
      return 'Sent back with your notes.';
    }
    case 'answer_teammate': return workday.answer(ctx.botId, args.id, args.answer);
    case 'escalate_to_neil': return workday.escalate(ctx.botId, args.id, args.note, ({ botId, question }) =>
      postCard({ botId, chatId: chats.dmFor(botId).id, origin: 'mission' }, { type: 'question', question, options: [], async: true, for: 'user' }));
    case 'post_report': company.postReport(ctx.botId, args.kind === 'eod' ? 'eod' : 'standup', args.text); return 'Posted.';
    case 'request_hire': {
      const msg = postCard(ctx, { type: 'hire', title: `Hire a ${args.title}`, role: args.title, why: args.why, name: args.name || '', boss: ctx.botId });
      return `Asked Neil to approve hiring a ${args.title}. You'll hear back here.`;
    }
    case 'desktop_screenshot':
    case 'desktop': {
      if (!computer.onLaptop(ctx.botId)) return 'Desktop tools need a laptop. This Bot is using a browser on the Mac; use the browser tools.';
      await computer.ensureBrowser(ctx.botId);
      if (tool === 'desktop') { await laptop.desktop(ctx.botId, args); await new Promise((r) => setTimeout(r, args.action === 'open' ? 2500 : 600)); }
      const shot = await laptop.screenshot(ctx.botId, 55);
      return { __image: shot.data, mime: shot.mime, text: tool === 'desktop' ? `Done: ${args.action}. This is the screen now.` : 'Your laptop screen.' };
    }
    case 'start_squad': {
      const r = await squads.start({ leadId: ctx.botId, chatId: ctx.chatId, goal: args.goal, parts: args.parts, merge: args.merge });
      return `Squad started: ${r.parts} parts, ${r.parallel} at a time, writing to ${r.folder}. End your turn now with one short line to the user. You'll be woken with the results.`;
    }
    case 'approval_prompt': {
      const chat = chats.getChat(ctx.chatId);
      const decisionCtx = { ...ctx, isGroup: chat?.kind === 'group' };
      if (chat && chat.kind !== 'dm') decisionCtx.chatId = chats.dmFor(ctx.botId).id;
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
    case 'message_bot': {
      const text = [args.text, args.message, args.body, args.content].find((x) => typeof x === 'string' && x.trim());
      if (!text) throw new Error('Put the message in "text".');
      if (ctx.origin !== 'chat') {
        const target = chats.findBot(args.to || args.bot || args.name);
        if (!target) throw new Error(`No Bot named ${args.to}`);
        if (target.id === ctx.botId) throw new Error("You can't message yourself");
        workday.deliver({ to: target.id, from: ctx.botId, kind: 'message', text: args.expect_reply === false ? text : `${text}\n(Reply with message_bot to ${bot.name}.)` });
        return `In ${target.name}'s inbox. They'll handle it in their next session${args.expect_reply === false ? '' : ' and reply to your inbox'}. Don't wait: keep working.`;
      }
      return engine.handoff({ fromBot: ctx.botId, fromChat: ctx.chatId, to: args.to || args.bot || args.name, text, expectReply: args.expect_reply !== false, depth: Number(ctx.depth || 0) });
    }
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
      if (app.id === 'gmail') {
        if (gmail.connected()) return `Gmail (${gmail.email()}) is connected. Use gmail_search, gmail_read and gmail_update, and draft_message for anything outgoing. Don't use the browser for Gmail.`;
        const msg = postCard(ctx, { type: 'gmail_connect', title: 'Connect Gmail for your whole team', name: 'Gmail' });
        if (ctx.origin !== 'chat') return 'Asked Neil to connect Gmail. Don\'t wait: do other work now and try Gmail again in a later session.';
        const res = await waitCard(msg.id, ctx);
        return res.connected ? `Gmail is connected for the whole team. Use gmail_search, gmail_read and gmail_update.` : 'The user didn\'t connect Gmail yet.';
      }
      const row = connectors.add(app.id);
      let c = connectors.installed(ctx.botId).find((x) => x.id === row.id);
      if (c.status === 'Connected') {
        if (c.kind !== 'browser' || await accounts.verify(ctx.botId, app.id)) return `${app.name} is connected.`;
        connectors.setStatus(ctx.botId, c.id, 'Needs auth'); // the cookies are there but the site signed it out
      }
      // Someone on the team already signed in: use that instead of asking the user.
      if (c.kind === 'browser' && await accounts.borrow(ctx.botId, app.id).catch(() => false)) {
        c = connectors.installed(ctx.botId).find((x) => x.id === row.id);
        if (c.status === 'Connected') return `${app.name} is connected with the team's sign-in. Continue.`;
      }
      const msg = postCard(ctx, { type: 'connect', connectorId: c.id, name: app.name, color: app.color, title: `Connect ${app.name}` }, '');
      if (ctx.origin !== 'chat') return `Asked Neil to connect ${app.name}. Don't wait: do other work now and try ${app.name} again in a later session.`;
      const res = await waitCard(msg.id, ctx);
      return res.connected ? `${app.name} is connected. Continue.` : res.expired ? 'The Connect card expired.' : `The user didn't connect ${app.name}.`;
    }
    case 'request_takeover': {
      if (gmail.connected() && /\b(gmail|google|inbox|mail)\b/i.test(args.reason || '') && /sign|log ?in|signed out|account chooser/i.test(args.reason || '')) {
        return `Don't sign in to Gmail in the browser: Gmail (${gmail.email()}) is connected for the whole team. Use gmail_search, gmail_read and gmail_update, and draft_message to send.`;
      }
      const bg = ctx.origin !== 'chat';
      const msg = postCard(ctx, { type: 'takeover', reason: args.reason, title: 'Take over the computer', ...(bg ? { async: true } : {}) });
      computer.startTakeover({ reason: args.reason, botId: ctx.botId, chatId: msg.chat_id });
      computer.bringToFront(ctx.botId).catch(() => {});
      if (bg) return 'Asked Neil to do this step on your laptop. Don\'t wait: work on things that don\'t need the browser now. Your inbox tells you when he\'s done.';
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
      if (ctx.origin !== 'chat') return `Asked Neil to save ${args.name}. Don't wait: do other work now and try again in a later session.`;
      const res = await waitCard(msg.id, ctx);
      return res.saved ? `Saved "${res.saved}" in the Vault. Use vault_fill_login on the sign-in page.` : res.expired ? 'The request expired.' : 'The user declined.';
    }
    case 'draft_message': {
      args.app = args.app || (/@/.test(args.to || '') ? 'Email' : 'Message');
      if (!String(args.body || '').trim()) throw new Error('Put the full message in "body".');
      // One draft per recipient: update the open one instead of piling up another.
      const norm = (x) => String(x || '').toLowerCase().replace(/\s+/g, '');
      const mine = all(`SELECT * FROM messages WHERE bot_id = ? AND card LIKE '%"type":"draft"%' AND created > ? ORDER BY created DESC LIMIT 60`, ctx.botId, now() - 21 * 864e5)
        .map(chats.parseMsg).find((m) => ['pending', 'review', 'returned'].includes(m.card?.status) && norm(m.card.to) === norm(args.to));
      // Routine emails go to the writer's boss, who approves and sends them. Big ones (where the
      // impression matters for the company's future) go to Neil. Nobody waits on either.
      const route = ctx.origin === 'chat' ? { route: 'owner', why: '' } : await workday.triageEmail(ctx.botId, { ...args, thread: args.thread || mine?.card.thread });
      const boss = route.route === 'boss' ? route.boss : null;
      const routing = boss
        ? { status: 'review', reviewer: boss.name, reviewSince: now(), routine: true, big: false, why: route.why }
        : { status: 'pending', routine: false, big: ctx.origin !== 'chat', why: route.why, reviewer: null };
      const askBoss = (msg) => workday.deliver({ to: boss.id, from: ctx.botId, kind: 'review', ref: msg.id,
        text: `To: ${args.to}${args.cc ? ` (cc ${args.cc})` : ''}${args.subject ? `\nSubject: ${args.subject}` : ''}\n\n${args.body}` });
      if (mine) {
        chats.updateMessage(mine.id, { card: { ...mine.card, app: args.app, cc: args.cc || mine.card.cc || '', subject: args.subject ?? mine.card.subject, body: args.body, thread: args.thread || mine.card.thread || '',
          reviewedBy: null, reviewNote: null, ...routing } });
        if (boss) askBoss(mine);
        return `Updated your existing draft to ${args.to}${boss ? `; ${boss.name} decides on it` : ''}. Keep working.`;
      }
      const dm = postCard(ctx, { type: 'draft', app: args.app, to: args.to, cc: args.cc || '', subject: args.subject || '', body: args.body, thread: args.thread || '', title: `${args.app} draft`, ...routing });
      if (boss) askBoss(dm);
      const actId = activity.log({ runId: ctx.runId, botId: ctx.botId, chatId: dm.chat_id, kind: 'draft', tool: 'draft_message', summary: `${args.app} draft to ${args.to}${args.subject ? `: ${args.subject}` : ''}`, detail: args.body, status: 'pending', origin: ctx.origin });
      chats.updateMessage(dm.id, { meta: { ...(dm.meta || {}), actId } });
      if (boss) return `Routine email: ${boss.name} reviews it and sends it. Don't send it yourself, and don't wait: keep working.`;
      return ctx.origin === 'chat' ? 'The draft is shown to the user with Send and Discard. Do not send it yourself. If they press Send, you will be asked to send it.'
        : `This one matters (${route.why || 'high stakes'}), so it goes to Neil. Don't send it yourself and don't wait for him: keep working on other things.`;
    }
    case 'ask_user': {
      if (ctx.origin !== 'chat') {
        const r = await workday.ask(ctx, { question: String(args.question || ''), options: args.options || [] });
        if (r.routed === 'boss') return `Asked ${r.to}, your boss. Don't wait: carry on with your other work now. The answer arrives in your inbox in a later session.`;
        postCard({ ...ctx, chatId: chats.dmFor(ctx.botId).id }, { type: 'question', question: args.question, options: args.options || [], fields: args.fields || [], async: true, for: 'user' });
        return 'Asked Neil. Don\'t wait: carry on with your other work now. His answer arrives in your inbox in a later session.';
      }
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
    case 'start_mission': {
      const m = missions.create({ botId: ctx.botId, title: args.title, goal: args.goal, doneWhen: args.done_when || '', hours: args.hours || 'any', dailyBudget: args.daily_sessions || 12 });
      return { started: m.title, note: 'Your first work session starts in a moment, in its own conversation. Tell the user in one line that you are on it.' };
    }
    case 'set_mission_plan': return missions.setPlan(ctx.botId, args.plan);
    case 'mission_checkpoint': return missions.checkpoint(ctx.botId, args);
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
