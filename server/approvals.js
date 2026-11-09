// Approvals and Auto Review.
//
// Every action a Bot proposes that isn't read-only comes here (Claude Code's
// permission prompt tool). Auto Review (on by default) lets it run or stops to ask,
// using built-in safety checks plus your Custom Rules ("Allow automatically" /
// "Ask first"; Ask first wins). Asking shows an approval card in the chat with
// Allow once / Always allow / Deny. Cards from routines or other background work
// expire after 30 minutes.
import { all, get, run, uid, now, setting } from './db.js';
import { quickJson } from './claude.js';
import * as chats from './chats.js';
import * as computer from './computer.js';
import { emit } from './bus.js';

const RULE_LIMIT = 20;
const BACKGROUND_TTL = 30 * 60 * 1000;
const pending = new Map(); // card message id -> { resolve, timer, input, ctx }

export const rules = () => all('SELECT * FROM rules ORDER BY created');

export function addRule(kind, text) {
  if (!['allow', 'ask'].includes(kind)) throw new Error('kind must be allow or ask');
  text = String(text).trim().slice(0, 1000);
  if (!text) throw new Error('Describe the action');
  const mine = all('SELECT * FROM rules WHERE kind = ? ORDER BY created', kind);
  if (mine.length >= RULE_LIMIT) {
    if (kind === 'ask') throw new Error('Each list allows up to 20 rules');
    run('DELETE FROM rules WHERE id = ?', mine[0].id); // Always allow at the limit drops the oldest Allow rule
  }
  const id = uid('rule_');
  run('INSERT INTO rules (id, kind, text, created) VALUES (?,?,?,?)', id, kind, text, now());
  emit('settings');
  return id;
}
export const removeRule = (id) => { run('DELETE FROM rules WHERE id = ?', id); emit('settings'); };

const BROWSER_WRITE = /^mcp__playwright__browser_(click|type|fill_form|press_key|select_option|file_upload|evaluate|drag|handle_dialog|hover)$/;
const BROWSER_ANY = /^mcp__playwright__browser_/;

export function describe(tool, input = {}) {
  const t = tool.replace(/^mcp__playwright__browser_/, '');
  switch (t) {
    case 'click': return `Click "${input.element || input.ref}"`;
    case 'type': return `Type "${String(input.text || '').slice(0, 120)}" into ${input.element || 'a field'}${input.submit ? ' and submit' : ''}`;
    case 'fill_form': return `Fill a form (${(input.fields || []).map((f) => f.name).join(', ')})`;
    case 'press_key': return `Press ${input.key}`;
    case 'select_option': return `Choose ${JSON.stringify(input.values)} in ${input.element}`;
    case 'file_upload': return `Upload ${(input.paths || []).length} file(s)`;
    case 'evaluate': return 'Run a script in the page';
    case 'handle_dialog': return `${input.accept ? 'Accept' : 'Dismiss'} a page dialog`;
    case 'drag': return `Drag ${input.startElement} to ${input.endElement}`;
  }
  if (tool === 'Bash') return `Run on this computer: ${input.command}`;
  if (tool === 'Write' || tool === 'Edit') return `${tool} ${input.file_path}`;
  if (tool === 'WebFetch') return `Fetch ${input.url}`;
  return `${tool.replace(/^mcp__/, '').replace(/__/g, ' → ')} ${JSON.stringify(input).slice(0, 200)}`;
}

function warningsFor(text) {
  const w = [];
  if (/\b(delete|remove|trash|discard|cancel|refund|archive all|rm\s|drop table|unsubscribe|close account)\b/i.test(text)) w.push("This can't be undone");
  if (/\b(password|2fa|two-factor|security|sign out|log out|recovery|passkey|permissions?)\b/i.test(text)) w.push('This changes sign-in or security settings');
  if (/\b(send|post|publish|share|submit|reply|invite|tweet|comment|message|email|upload|forward)\b/i.test(text)) w.push('This shares your data outside this chat');
  if (/\b(pay|purchase|buy|checkout|place order|transfer|subscribe|upgrade plan|confirm order)\b/i.test(text)) w.push('This spends money');
  return w;
}

async function ruleVerdict(summary, pageUrl) {
  const list = rules();
  if (!list.length) return null;
  const numbered = list.map((r, i) => `${i + 1}. [${r.kind === 'allow' ? 'ALLOW AUTOMATICALLY' : 'ASK FIRST'}] ${r.text}`).join('\n');
  try {
    const j = await quickJson(
      `Action a Bot wants to take: ${summary}\nCurrent page: ${pageUrl || 'n/a'}\n\nRules:\n${numbered}\n\n` +
      'Which rules clearly match this action? Reply with JSON only: {"allow":[rule numbers],"ask":[rule numbers]}',
      { system: 'You match proposed agent actions against user-written permission rules. Be literal and conservative.' });
    const ask = (j.ask || []).map((n) => list[n - 1]).filter(Boolean);
    const allow = (j.allow || []).map((n) => list[n - 1]).filter(Boolean);
    if (ask.length) return { verdict: 'ask', rule: ask[0] };
    if (allow.length) return { verdict: 'allow', rule: allow[0] };
  } catch {}
  return null;
}

// Called for each proposed action. ctx: { botId, chatId, origin, isGroup, runId }
export async function decide(tool, input, ctx) {
  const allow = () => ({ behavior: 'allow', updatedInput: input });

  if (BROWSER_ANY.test(tool)) {
    if (computer.state.control === 'user') {
      computer.setActivity('Waiting — you have control');
      await computer.waitForBotControl();
    }
    computer.setActivity(`${chats.getBot(ctx.botId)?.name || 'Bot'}: ${describe(tool, input)}`);
  }

  const summary = describe(tool, input);
  let pageUrl = '';
  if (BROWSER_ANY.test(tool)) pageUrl = (await computer.pages())[0]?.url || '';

  // Execution on this computer (Settings → Computer).
  if (tool === 'Bash') {
    const mode = setting('local_execution');
    if (mode === 'never') return { behavior: 'deny', message: 'Running commands on this computer is set to Never allow.' };
    if (mode === 'ask') {
      const r = await ruleVerdict(summary, pageUrl);
      if (r?.verdict === 'allow') return allow();
      return ask(tool, input, summary, ctx, { kind: 'command', reason: r?.rule ? `Ask first: ${r.rule.text}` : null });
    }
  }

  if (setting('auto_review') !== '1') return allow();

  // Read-only browser steps never need review.
  if (BROWSER_ANY.test(tool) && !BROWSER_WRITE.test(tool)) return allow();

  const r = await ruleVerdict(summary, pageUrl);
  if (r?.verdict === 'ask') return ask(tool, input, summary, ctx, { kind: 'rule', rule: r.rule, reason: `Ask first: ${r.rule.text}` });
  if (r?.verdict === 'allow') return allow();

  // Built-in safety checks always apply.
  const text = `${summary} ${pageUrl}`;
  const w = warningsFor(text);
  const risky = w.length && !ctx.preapproved && (BROWSER_WRITE.test(tool) || tool === 'Bash' || tool.startsWith('mcp__app_'));
  if (risky) return ask(tool, input, summary, ctx, { kind: 'safety', warnings: w });
  return allow();
}

function ask(tool, input, summary, ctx, { kind, reason, rule, warnings } = {}) {
  const background = ctx.origin !== 'chat';
  const card = {
    type: 'approval', status: 'pending', kind, tool, summary, reason: reason || null,
    inputs: JSON.stringify(input, null, 2).slice(0, 4000),
    warnings: warnings || warningsFor(summary),
    allowAlways: !ctx.isGroup, // group chat cards don't offer Always allow
    expires: background ? now() + BACKGROUND_TTL : null,
  };
  const msg = chats.addMessage({ chatId: ctx.chatId, author: 'bot', botId: ctx.botId, text: '', card });
  emit('notify', { botId: ctx.botId, chatId: ctx.chatId, title: 'Approval needed', body: summary });
  return new Promise((resolve) => {
    const entry = { resolve, input, ctx, summary };
    if (background) entry.timer = setTimeout(() => answer(msg.id, 'expire'), BACKGROUND_TTL);
    pending.set(msg.id, entry);
  });
}

export function answer(msgId, choice) {
  const p = pending.get(msgId);
  const msg = chats.getMessage(msgId);
  if (!p || !msg?.card) return false;
  pending.delete(msgId);
  clearTimeout(p.timer);
  const card = { ...msg.card };
  if (choice === 'allow' || choice === 'always') {
    card.status = 'allowed';
    if (choice === 'always' && card.allowAlways) {
      addRule('allow', p.summary);
      card.saved = 'Saved to Custom Rules';
    }
    chats.updateMessage(msgId, { card });
    p.resolve({ behavior: 'allow', updatedInput: p.input });
  } else {
    card.status = choice === 'expire' ? 'expired' : 'denied';
    chats.updateMessage(msgId, { card });
    p.resolve({
      behavior: 'deny',
      message: choice === 'expire'
        ? 'The approval request expired after 30 minutes. Stop and report that this step needs approval.'
        : 'The user denied this action. Do not retry it or ask again until the user sends another message.',
    });
  }
  return true;
}

// When a run is stopped, pending cards for it are denied.
export function cancelFor(runId) {
  for (const [id, p] of pending) if (p.ctx.runId === runId) answer(id, 'deny');
}

export const pendingCount = () => pending.size;
