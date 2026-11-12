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
import * as activity from './activity.js';

const RULE_LIMIT = 20;
const BACKGROUND_TTL = 10 * 60 * 1000; // a Bot on a shift moves on after this
const pending = new Map(); // card message id -> { resolve, timer, input, ctx, structured }

// Structured rule columns (added after v0.1).
for (const col of ['tool', 'pattern']) {
  try { db.exec(`ALTER TABLE rules ADD COLUMN ${col} TEXT`); } catch {}
}

// v0.5: "Ask every time" for commands was replaced as the default by "Only risky commands".
if (!setting('exec_v2')) {
  if (setting('local_execution') === 'ask') run("UPDATE settings SET value = 'smart' WHERE key = 'local_execution'");
  run("INSERT OR REPLACE INTO settings (key, value) VALUES ('exec_v2', '1')");
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

// The simple commands in a shell line, as words, ignoring heredoc bodies, quoted text and
// VAR=… prefixes. The first word of each is the program ('sudo' is kept as its own entry).
function commandsOf(command = '') {
  let cmd = String(command);
  cmd = cmd.replace(/<<-?\s*['"]?(\w+)['"]?[^\n]*\n[\s\S]*?\n\s*\1\s*(\n|$)/g, '\n');
  cmd = cmd.replace(/\\ /g, '_');
  cmd = cmd.replace(/'[^']*'/g, "''").replace(/"(?:\\.|[^"\\])*"/g, '""');
  const out = [];
  for (const seg of cmd.split(/&&|\|\||;|\||\n|\$\(|`/)) {
    const words = seg.trim().split(/\s+/).filter(Boolean);
    while (words.length && /^\w+=/.test(words[0])) words.shift();
    while (words.length && ['sudo', 'env', 'time', 'nohup', 'exec', 'then', 'do', 'else', '{', '(', '!'].includes(words[0])) {
      if (words[0] === 'sudo') out.push(['sudo']);
      words.shift();
    }
    let w = words[0];
    if (!w || /^[)}]|^(fi|done|esac|for|while|if|in)$/.test(w)) continue;
    w = w.replace(/^["'(]+|[)"']+$/g, '');
    if (w.includes('/')) w = w.split('/').pop();
    if (w) out.push([w, ...words.slice(1)]);
  }
  return out;
}
export const programsOf = (command = '') => [...new Set(commandsOf(command).map((c) => c[0]))];

const READ_ONLY_PROGRAMS = new Set(['ls', 'cat', 'head', 'tail', 'grep', 'egrep', 'rg', 'wc', 'pwd', 'echo', 'printf', 'date', 'which',
  'file', 'stat', 'cd', 'test', 'true', 'false', 'sort', 'uniq', 'cut', 'tr', 'basename', 'dirname', 'realpath', 'du', 'df', 'jq',
  'shasum', 'md5', 'diff', 'tree', 'less', 'column', 'awk', 'seq', 'whoami', 'uname', 'sw_vers', 'mdfind', 'plutil',
  'nl', 'comm', 'paste', 'fold', 'rev', 'strings', 'xxd', 'od', 'cmp', 'ps', 'id', 'hostname', 'sleep', 'type', 'command']);

// "Only risky commands" mode: everyday local work (reading, writing and organizing files,
// running scripts, fetching pages) runs on its own. These are the things that still ask.
const SCRIPT_PROGRAMS = /^(python3?|node|ruby|perl|swift|php|deno|bun|bash|sh|zsh)$/;
const SENSITIVE_PATH = /(~|\$HOME|\/Users\/[^/\s"']+)\/(\.(ssh|aws|gnupg|netrc|zshrc|zprofile|zshenv|bashrc|bash_profile|profile|gitconfig|kube|docker)\b|\.config\/gh\b|Library\/(Keychains|LaunchAgents|Cookies)\b)|(^|[\s"'=:])\/(etc|System|bin|sbin|private\/etc|Library\/(LaunchDaemons|LaunchAgents|Keychains))\b|(^|[\s"'=:])\/usr\/(?!local\b)/;
const safeTarget = (a) => a && a !== '""' && a !== "''" && !/^(~|\$|\.\.|\*$|\/(?!tmp\/|private\/tmp\/|var\/folders\/))/.test(a);

export function localRisk(command) {
  const c = String(command);
  const cmds = commandsOf(c);
  const progs = cmds.map((x) => x[0]);
  const w = new Set();
  for (const [p, ...args] of cmds) {
    const targets = args.filter((a) => !a.startsWith('-'));
    if (p === 'rm' || p === 'rmdir' || p === 'unlink' || p === 'shred') { if (!targets.length || !targets.every(safeTarget)) w.add('Deletes files outside its working folder'); }
    else if (p === 'find' && args.some((a) => a === '-delete' || a === '-exec' || a === '-execdir')) w.add('Deletes or changes many files');
    else if (/^(kill|pkill|killall)$/.test(p)) w.add('Stops programs running on your Mac');
    else if (p === 'osascript') w.add('Controls other apps on your Mac');
    else if (p === 'brew' && /^(install|reinstall|upgrade|uninstall|remove|tap)$/.test(args[0] || '')) w.add('Installs or removes software on your Mac');
    else if (/^(npm|pnpm|yarn)$/.test(p) && args.some((a) => a === '-g' || a === '--global' || a === 'global')) w.add('Installs software for your whole Mac');
    else if (/^(gem|port|softwareupdate|installer|mas)$/.test(p)) w.add('Installs or removes software on your Mac');
    else if (p === 'crontab' || p === 'pmset' || p === 'networksetup' || p === 'scutil' || p === 'csrutil' || p === 'spctl') w.add('This changes system or security settings');
  }
  const writes = /(^|[^<>&0-9])>>?\s*[^&\s]|\btee\b|\b(cp|mv|ln|chmod|touch|mkdir|install|sed\s+-i|perl\s+-pi)\b/.test(c);
  const scripts = progs.some((p) => SCRIPT_PROGRAMS.test(p));
  if (SENSITIVE_PATH.test(c) && (writes || scripts)) w.add('Touches system, sign-in or startup files');
  if (scripts) {
    // A script's own code is in the command (inline or a heredoc): look at what it does.
    if (/requests\.(post|put|patch|delete)\(|urlopen\([^)]*data\s*=|method\s*[:=]\s*['"](POST|PUT|PATCH|DELETE)|smtplib|sendmail|axios\.(post|put|patch|delete)|\bcurl\b[^\n]*\s(-d|--data\S*|-F|-T|-X\s*(POST|PUT|PATCH|DELETE))\s/i.test(c)) w.add('This shares your data outside this computer');
    if (/shutil\.rmtree|os\.(remove|unlink|rmdir|removedirs)\(|\.unlink\(|unlinkSync|rmSync|rmdirSync|send2trash|\brm\s+-\w*[rf]/.test(c)) w.add('Deletes files');
    if (/keyring|Keychain|find-(generic|internet)-password/i.test(c)) w.add('Reads saved passwords');
  }
  return [...w];
}

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
  if (/\bsecurity\s+(find-(generic|internet)-password|dump-keychain)\b/.test(c)) w.push('Reads saved passwords');
  if (/(~|\$HOME|\/Users\/[^/\s"']+)\/(\.(ssh|aws|gnupg|netrc|kube|docker)\b|\.config\/gh\b|Library\/(Keychains|Cookies)\b)/.test(c)) w.push('Reads private keys or saved sign-ins');
  return w;
}

// A Bot's commands on its own laptop run in a container, so they just run. Two exceptions,
// refused without asking anyone: deleting in the folders shared with the Mac (real files),
// and pushing code.
export function laptopShell(command) {
  const c = String(command);
  if (/\bgit\s+push\b/.test(c)) return 'Pushing code needs Neil. Note it in your end-of-day report and keep working on something else.';
  const destructive = localRisk(c).some((w) => /^Deletes/.test(w)) || shellDanger(c).includes("This can't be undone") || /\bgit\s+(reset\s+--hard|clean\b|checkout\s+--\s)/.test(c);
  if (!destructive) return null;
  let shared = [];
  try { shared = JSON.parse(setting('laptop_folders') || '[]'); } catch {}
  const hit = shared.find((f) => f && c.includes(f));
  if (hit) return `That deletes or overwrites files in ${hit}, a folder with Neil's real files. Work on a copy in your own workspace instead.`;
  return null;
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
  if (tool === 'site_fetch') {
    const h = host(pageUrl) || '*';
    return { tool, pattern: h, label: `Always allow on ${h}`, text: `Sending data to ${h} with your sign-in` };
  }
  return { tool, pattern: '*', label: 'Always allow', text: describe(tool, input) };
}

// For Tandem's own tools that change things somewhere: ask unless an Always allow rule covers
// it. Resolves to { behavior: 'allow' | 'deny', message }.
export function confirm(tool, input, ctx, { summary, url, warnings = [] }) {
  if (ctx.preapproved || structuredMatch(tool, input, url, 'allow')) return Promise.resolve({ behavior: 'allow' });
  return ask(tool, input, summary, url, ctx, { kind: 'safety', warnings });
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
    if (computer.machine(ctx.botId).control === 'user' && ctx.origin !== 'chat') {
      return { behavior: 'deny', message: 'Neil is using your browser right now (a step you asked him for). Work on something that doesn\'t need the browser; your inbox tells you when it\'s yours again.' };
    }
    if (computer.machine(ctx.botId).control === 'user') {
      computer.setActivity(ctx.botId, 'Waiting, you have control');
      await computer.waitForBotControl(ctx.botId);
    }
    computer.setActivity(ctx.botId, describe(tool, input));
    pageUrl = (await computer.pages(ctx.botId))[0]?.url || '';
  }
  const summary = describe(tool, input);
  const detail = tool === 'Bash' ? String(input.command || '') : JSON.stringify(input);

  // Ask-first rules always win.
  if (structuredMatch(tool, input, pageUrl, 'ask')) return ask(tool, input, summary, pageUrl, ctx, { kind: 'rule', reason: 'Matches one of your Ask first rules' });

  if (tool === 'Bash' && computer.onLaptop(ctx.botId) && !ctx.preapproved) {
    const v = laptopShell(input.command);
    return v ? { behavior: 'deny', message: v } : allow();
  }
  if (tool === 'Bash') {
    const mode = setting('local_execution');
    if (mode === 'never') return { behavior: 'deny', message: 'Running commands on this computer is set to Never allow.' };
    const danger = ctx.preapproved ? [] : shellDanger(input.command);
    const progs = programsOf(input.command);
    const readOnly = progs.every((p) => READ_ONLY_PROGRAMS.has(p));
    if (danger.length) return ask(tool, input, summary, pageUrl, ctx, { kind: 'command', warnings: danger });
    if (mode === 'always' || readOnly || structuredMatch(tool, input, pageUrl, 'allow')) return allow();
    if (mode === 'smart') {
      const risk = ctx.preapproved ? [] : localRisk(input.command);
      if (risk.length) return ask(tool, input, summary, pageUrl, ctx, { kind: 'command', warnings: risk });
      const r = await textRuleVerdict(summary, detail);
      if (r?.verdict === 'ask') return ask(tool, input, summary, pageUrl, ctx, { kind: 'rule', reason: `Ask first: ${r.rule.text}` });
      return allow();
    }
    const r = await textRuleVerdict(summary, detail);
    if (r?.verdict === 'allow') return allow();
    return ask(tool, input, summary, pageUrl, ctx, { kind: 'command', reason: r?.rule ? `Ask first: ${r.rule.text}` : null });
  }

  if (/^(Write|Edit|MultiEdit|NotebookEdit)$/.test(tool) && SENSITIVE_PATH.test(String(input.file_path || input.notebook_path || '')) && !ctx.preapproved) {
    return ask(tool, input, summary, pageUrl, ctx, { kind: 'safety', warnings: ['Touches system, sign-in or startup files'] });
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
  const actId = activity.log({ runId: ctx.runId, botId: ctx.botId, chatId: ctx.chatId, kind: 'approval', tool, summary: `Asked to: ${summary}`, detail: card.command || null, status: 'pending', origin: ctx.origin });
  return new Promise((resolve) => {
    const entry = { resolve, input, ctx, summary, structured: s, actId };
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
    activity.finish(p.actId, 'allowed');
    if (choice === 'always' && card.allowAlways && p.structured) {
      addRule('allow', p.structured.text, { tool: p.structured.tool, pattern: p.structured.pattern });
      card.saved = `Saved: ${p.structured.text}`;
    }
    chats.updateMessage(msgId, { card });
    p.resolve({ behavior: 'allow', updatedInput: p.input });
  } else {
    card.status = choice === 'expire' ? 'expired' : 'denied';
    activity.finish(p.actId, card.status);
    chats.updateMessage(msgId, { card });
    p.resolve({
      behavior: 'deny',
      message: choice === 'expire'
        ? 'No answer on this approval yet. Skip this step for now, note it in your plan, and keep working on everything else.'
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
