// Approvals and Auto Review.
//
// Every action a Bot proposes that isn't read-only comes here (Claude Code's
// permission prompt tool). Auto Review (on by default) lets it run or stops to ask,
// using built-in safety checks plus your Custom Rules ("Allow automatically" /
// "Ask first"; Ask first wins). Asking shows an approval card in the chat with
// Allow once / Always allow / Deny. Cards from routines or other background work
// expire after 30 minutes.
//
// "Always allow" saves a structured rule that matches deterministically:
//   Bash     → the programs the command runs (e.g. python3, grep)
//   browser  → the action type on that website (e.g. typing on mail.google.com)
//   app tool → that tool
// Rules you write yourself are plain language and matched by a small model.
import { all, run, uid, now, setting, db } from './db.js';
import { quickJson } from './claude.js';
import * as chats from './chats.js';
import * as computer from './computer.js';
import { emit } from './bus.js';

const RULE_LIMIT = 20;
const BACKGROUND_TTL = 30 * 60 * 1000;
const pending = new Map(); // card message id -> { resolve, timer, input, ctx, structured }

// Structured rule columns (added after v0.1).
for (const col of ['tool', 'pattern']) {
  try { db.exec(`ALTER TABLE rules ADD COLUMN ${col} TEXT`); } catch {}
}

export const rules = () => all('SELECT * FROM rules ORDER BY created');

export function addRule(kind, text, { tool = null, pattern = null } = {}) {
  if (!['allow', 'ask'].includes(kind)) throw new Error('kind must be allow or ask');
  text = String(text).trim().slice(0, 1000);
  if (!text) throw new Error('Describe the action');
  if (tool && all('SELECT id FROM rules WHERE kind = ? AND tool = ? AND pattern = ?', kind, tool, pattern).length) return null;
  const mine = all('SELECT * FROM rules WHERE kind = ? ORDER BY created', kind);
  if (mine.length >= RULE_LIMIT) {
    if (kind === 'ask') throw new Error('Each list allows up to 20 rules');
    run('DELETE FROM rules WHERE id = ?', mine[0].id); // Always allow at the limit drops the oldest Allow rule
  }
  const id = uid('rule_');
  run('INSERT INTO rules (id, kind, text, created, tool, pattern) VALUES (?,?,?,?,?,?)', id, kind, text, now(), tool, pattern);
  emit('settings');
  return id;
}
export const removeRule = (id) => { run('DELETE FROM rules WHERE id = ?', id); emit('settings'); };

const BROWSER_WRITE = /^mcp__playwright__browser_(click|type|fill_form|press_key|select_option|file_upload|evaluate|drag|handle_dialog|hover)$/;
const BROWSER_ANY = /^mcp__playwright__browser_/;

// ---- Shell commands ------------------------------------------------------------------

// The programs a shell command runs, ignoring heredoc bodies, quoted text and VAR=… prefixes.
export function programsOf(command = '') {
  let cmd = String(command);
  cmd = cmd.replace(/<<-?\s*['"]?(\w+)['"]?[^\n]*\n[\s\S]*?\n\s*\1\s*(\n|$)/g, '\n');
  cmd = cmd.replace(/\\ /g, '_');
  cmd = cmd.replace(/'[^']*'/g, "''").replace(/"(?:\\.|[^"\\])*"/g, '""');
  const out = new Set();
  for (const seg of cmd.split(/&&|\|\||;|\||\n|\$\(|`/)) {
    const words = seg.trim().split(/\s+/).filter(Boolean);
    while (words.length && /^\w+=/.test(words[0])) words.shift();
    while (words.length && ['sudo', 'env', 'time', 'nohup', 'exec', 'then', 'do', 'else', '{', '(', '!'].includes(words[0])) {
      if (words[0] === 'sudo') out.add('sudo');
      words.shift();
    }
    let w = words[0];
    if (!w || /^[)}]|^(fi|done|esac|for|while|if|in)$/.test(w)) continue;
    w = w.replace(/^["'(]+|[)"']+$/g, '');
    if (w.includes('/')) w = w.split('/').pop();
    if (w) out.add(w);
  }
  return [...out];
}

const READ_ONLY_PROGRAMS = new Set(['ls', 'cat', 'head', 'tail', 'grep', 'egrep', 'rg', 'wc', 'pwd', 'echo', 'printf', 'date', 'which',
  'file', 'stat', 'cd', 'test', 'true', 'false', 'sort', 'uniq', 'cut', 'tr', 'basename', 'dirname', 'realpath', 'du', 'df', 'jq',
  'shasum', 'md5', 'diff', 'tree', 'less', 'column', 'awk', 'seq', 'whoami', 'uname', 'sw_vers', 'mdfind', 'plutil']);

function shellDanger(command) {
  const c = String(command);
  const progs = programsOf(c);
  const w = [];
  if (progs.includes('sudo')) w.push('Runs with administrator rights');
  if (/\brm\s+(-\w*[rf]\w*\s+)+/.test(c) || /\bgit\s+(reset\s+--hard|clean\s+-\w*f|push\s+(-f|--force))/.test(c)) w.push("This can't be undone");
  if (/\bgit\s+push\b/.test(c) || /\b(scp|rsync|ssh|sftp|ftp|nc)\b/.test(c)
    || /\bcurl\b[^\n]*(\s-X\s*(POST|PUT|PATCH|DELETE)|\s(-d|--data\S*|-F|--form|-T|--upload-file)\s)/.test(c)
    || /\b(curl|wget)\b[^\n]*\|\s*(ba|z)?sh\b/.test(c) || /\bosascript\b[^\n]*(send|deliver|make new outgoing)/i.test(c)) {
    w.push('This shares your data outside this computer');
  }
  if (/\b(defaults\s+write|launchctl|security\s+(delete|add)|chmod\s+-R|chown)\b/.test(c)) w.push('This changes system or security settings');
  return w;
}

function browserDanger(tool, input, pageUrl) {
  const t = `${input.element || ''} ${input.text || ''} ${(input.fields || []).map((f) => f.name).join(' ')}`;
  const w = [];
  const click = /_click$/.test(tool) || (/_type$|_press_key$/.test(tool) && (input.submit || input.key === 'Enter'));
  if (click && /\b(send|post|publish|share|submit|reply|invite|tweet|comment|forward|upload)\b/i.test(t)) w.push('This shares your data outside this chat');
  if (click && /\b(delete|remove|trash|discard|cancel|refund|unsubscribe|close account|archive all)\b/i.test(t)) w.push("This can't be undone");
  if (click && /\b(pay|purchase|buy|checkout|place order|transfer|subscribe|upgrade)\b/i.test(t)) w.push('This spends money');
  if (/\b(password|2fa|two-factor|security|sign out|log out|recovery|passkey)\b/i.test(t) && /settings|account|security/i.test(pageUrl)) w.push('This changes sign-in or security settings');
  if (/_file_upload$/.test(tool)) w.push('This shares your data outside this chat');
  return w;
}

// ---- Descriptions ------------------------------------------------------------------------

const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };

export function describe(tool, input = {}) {
  const t = tool.replace(/^mcp__playwright__browser_/, '');
  switch (t) {
    case 'click': return `Click "${input.element || input.ref}"`;
    case 'type': return `Type into ${input.element || 'a field'}${input.submit ? ' and submit' : ''}`;
    case 'fill_form': return `Fill in ${(input.fields || []).map((f) => f.name).join(', ') || 'a form'}`;
    case 'press_key': return `Press ${input.key}`;
    case 'select_option': return `Choose ${[].concat(input.values || []).join(', ')} in ${input.element}`;
    case 'file_upload': return `Upload ${(input.paths || []).length} file(s)`;
    case 'evaluate': return 'Run a script in the page';
    case 'handle_dialog': return `${input.accept ? 'Accept' : 'Dismiss'} a page dialog`;
    case 'drag': return `Drag ${input.startElement} to ${input.endElement}`;
    case 'navigate': return `Open ${host(input.url) || input.url}`;
  }
  if (tool === 'Bash') return input.description ? input.description.replace(/\.$/, '') : `Run ${programsOf(input.command).slice(0, 3).join(', ') || 'a command'}`;
  if (tool === 'Write' || tool === 'Edit') return `${tool === 'Write' ? 'Write' : 'Edit'} ${String(input.file_path || '').split('/').pop()}`;
  if (tool === 'WebFetch') return `Read ${host(input.url) || input.url}`;
  return tool.replace(/^mcp__/, '').replace(/__/g, ': ').replace(/_/g, ' ');
}

// What "Always allow" would save for this action.
function structuredRule(tool, input, pageUrl) {
  if (tool === 'Bash') {
    const progs = programsOf(input.command).filter((p) => !READ_ONLY_PROGRAMS.has(p));
    if (!progs.length) return null;
    return { tool: 'Bash', pattern: progs.sort().join(' '), label: `Always allow ${progs.join(', ')}`,
      text: `Run ${progs.map((p) => `\`${p}\``).join(', ')} commands on this computer` };
  }
  if (BROWSER_ANY.test(tool)) {
    const h = host(pageUrl) || '*';
    const act = tool.replace(/^mcp__playwright__browser_/, '');
    const verb = { click: 'Clicking', type: 'Typing', fill_form: 'Filling forms', press_key: 'Pressing keys', select_option: 'Choosing options',
      file_upload: 'Uploading files', evaluate: 'Running scripts', handle_dialog: 'Answering dialogs', drag: 'Dragging', hover: 'Hovering' }[act] || act;
    return { tool, pattern: h, label: `Always allow on ${h}`, text: `${verb} on ${h}` };
  }
  return { tool, pattern: '*', label: 'Always allow', text: describe(tool, input) };
}

function structuredMatch(tool, input, pageUrl, kind) {
  const list = all('SELECT * FROM rules WHERE kind = ? AND tool IS NOT NULL', kind);
  if (!list.length) return null;
  if (tool === 'Bash') {
    const progs = programsOf(input.command).filter((p) => !READ_ONLY_PROGRAMS.has(p));
    const allowed = new Set(list.filter((r) => r.tool === 'Bash').flatMap((r) => r.pattern.split(' ')));
    if (kind === 'allow') return progs.length && progs.every((p) => allowed.has(p)) ? list.find((r) => r.tool === 'Bash') : null;
    return progs.some((p) => allowed.has(p)) ? list.find((r) => r.tool === 'Bash' && r.pattern.split(' ').some((x) => progs.includes(x))) : null;
  }
  const h = host(pageUrl);
  return list.find((r) => r.tool === tool && (r.pattern === '*' || r.pattern === h)) || null;
}

async function textRuleVerdict(summary, detail) {
  const list = all('SELECT * FROM rules WHERE tool IS NULL ORDER BY created');
  if (!list.length) return null;
  const numbered = list.map((r, i) => `${i + 1}. [${r.kind === 'allow' ? 'ALLOW AUTOMATICALLY' : 'ASK FIRST'}] ${r.text}`).join('\n');
  try {
    const j = await quickJson(
      `Action a Bot wants to take: ${summary}\nDetails: ${detail.slice(0, 1500)}\n\nRules:\n${numbered}\n\n` +
      'Which rules clearly match this action? Reply with JSON only: {"allow":[rule numbers],"ask":[rule numbers]}',
      { system: 'You match proposed agent actions against user-written permission rules. Be literal and conservative.' });
    const ask = (j.ask || []).map((n) => list[n - 1]).filter(Boolean);
    const allow = (j.allow || []).map((n) => list[n - 1]).filter(Boolean);
    if (ask.length) return { verdict: 'ask', rule: ask[0] };
    if (allow.length) return { verdict: 'allow', rule: allow[0] };
  } catch {}
  return null;
}

// ---- Decision ------------------------------------------------------------------------------

// Called for each proposed action. ctx: { botId, chatId, origin, isGroup, runId, preapproved }
export async function decide(tool, input, ctx) {
  const allow = () => ({ behavior: 'allow', updatedInput: input });

  let pageUrl = '';
  if (BROWSER_ANY.test(tool)) {
    if (computer.state.control === 'user') {
      computer.setActivity('Waiting, you have control');
      await computer.waitForBotControl();
    }
    computer.setActivity(`${chats.getBot(ctx.botId)?.name || 'Bot'}: ${describe(tool, input)}`);
    pageUrl = (await computer.pages())[0]?.url || '';
  }
  const summary = describe(tool, input);
  const detail = tool === 'Bash' ? String(input.command || '') : JSON.stringify(input);

  // Ask-first rules always win.
  if (structuredMatch(tool, input, pageUrl, 'ask')) return ask(tool, input, summary, pageUrl, ctx, { kind: 'rule', reason: 'Matches one of your Ask first rules' });

  if (tool === 'Bash') {
    const mode = setting('local_execution');
    if (mode === 'never') return { behavior: 'deny', message: 'Running commands on this computer is set to Never allow.' };
    const danger = ctx.preapproved ? [] : shellDanger(input.command);
    const progs = programsOf(input.command);
    const readOnly = progs.every((p) => READ_ONLY_PROGRAMS.has(p));
    if (danger.length) return ask(tool, input, summary, pageUrl, ctx, { kind: 'command', warnings: danger });
    if (mode === 'always' || readOnly || structuredMatch(tool, input, pageUrl, 'allow')) return allow();
    const r = await textRuleVerdict(summary, detail);
    if (r?.verdict === 'allow') return allow();
    return ask(tool, input, summary, pageUrl, ctx, { kind: 'command', reason: r?.rule ? `Ask first: ${r.rule.text}` : null });
  }

  if (setting('auto_review') !== '1') return allow();
  if (BROWSER_ANY.test(tool) && !BROWSER_WRITE.test(tool)) return allow();
  if (structuredMatch(tool, input, pageUrl, 'allow')) return allow();

  const r = await textRuleVerdict(summary, detail);
  if (r?.verdict === 'ask') return ask(tool, input, summary, pageUrl, ctx, { kind: 'rule', reason: `Ask first: ${r.rule.text}` });
  if (r?.verdict === 'allow') return allow();

  // Built-in safety checks.
  const w = ctx.preapproved ? [] : BROWSER_ANY.test(tool) ? browserDanger(tool, input, pageUrl) : [];
  if (w.length || tool.startsWith('mcp__app_')) return ask(tool, input, summary, pageUrl, ctx, { kind: 'safety', warnings: w });
  return allow();
}

function ask(tool, input, summary, pageUrl, ctx, { kind, reason, warnings = [] } = {}) {
  const background = ctx.origin !== 'chat';
  const s = structuredRule(tool, input, pageUrl);
  const card = {
    type: 'approval', status: 'pending', kind, tool, summary, reason: reason || null,
    command: tool === 'Bash' ? String(input.command || '') : null,
    site: host(pageUrl) || null,
    inputs: tool === 'Bash' ? null : JSON.stringify(input, null, 2).slice(0, 4000),
    warnings,
    allowAlways: !ctx.isGroup && !!s,
    alwaysLabel: s?.label || 'Always allow',
    expires: background ? now() + BACKGROUND_TTL : null,
  };
  const msg = chats.addMessage({ chatId: ctx.chatId, author: 'bot', botId: ctx.botId, text: '', card });
  emit('notify', { botId: ctx.botId, chatId: ctx.chatId, title: 'Approval needed', body: summary });
  return new Promise((resolve) => {
    const entry = { resolve, input, ctx, summary, structured: s };
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
    if (choice === 'always' && card.allowAlways && p.structured) {
      addRule('allow', p.structured.text, { tool: p.structured.tool, pattern: p.structured.pattern });
      card.saved = `Saved: ${p.structured.text}`;
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

// One-time cleanup: old "Always allow" rules saved a whole command or typed text.
// Convert command rules into program rules; drop the typed-text ones.
for (const r of all("SELECT * FROM rules WHERE kind = 'allow' AND tool IS NULL")) {
  if (r.text.startsWith('Run on this computer: ')) {
    const progs = programsOf(r.text.slice('Run on this computer: '.length)).filter((p) => !READ_ONLY_PROGRAMS.has(p));
    run('DELETE FROM rules WHERE id = ?', r.id);
    if (progs.length) addRule('allow', `Run ${progs.map((p) => `\`${p}\``).join(', ')} commands on this computer`, { tool: 'Bash', pattern: progs.sort().join(' ') });
  } else if (/^(Type "|Fill a form \()/.test(r.text)) {
    run('DELETE FROM rules WHERE id = ?', r.id);
  }
}
