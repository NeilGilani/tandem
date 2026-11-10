// Benchmark: how fast and how independently Bots finish real tasks.
//   node scripts/bench.mjs --url http://127.0.0.1:4801 --data /path/to/data [--only hn,pi] [--out results.json]
// Run it against a throwaway server (TANDEM_DATA=<tmp dir>), never your real one: it creates
// Bots and approves every action they ask for, counting each ask as an interruption.
import fs from 'node:fs';
import path from 'node:path';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const URL_ = arg('url', 'http://127.0.0.1:4801');
const DATA = arg('data');
const OUT = arg('out');
const ONLY = arg('only')?.split(',');
const TIMEOUT = Number(arg('timeout', 15)) * 60e3;
if (!DATA) { console.error('--data is required'); process.exit(1); }

const api = async (method, p, body) => {
  const r = await fetch(URL_ + p, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${p}: ${j.error || r.status}`);
  return j;
};
const read = (dir, f) => { try { return fs.readFileSync(path.join(dir, f), 'utf8'); } catch { return null; } };
const rows = (s) => (s || '').split('\n').filter((l) => /^\s*\|/.test(l) && !/^\s*\|[\s:|-]+\|\s*$/.test(l));

const TASKS = [
  { id: 'hn', text: 'Get the top 10 stories on Hacker News right now, with their points, and save them as hn.md (a Markdown table) in your working folder.',
    check: (w) => { const t = read(w, 'hn.md'); return { ok: rows(t).length >= 11, note: t ? `${rows(t).length - 1} rows` : 'no hn.md' }; } },
  { id: 'pi', text: 'Find the current US list price of every Raspberry Pi 5 memory size and save them to pi5.csv in your working folder with columns model,price_usd.',
    check: (w) => { const t = read(w, 'pi5.csv'); const n = (t || '').split('\n').filter((l) => /\d/.test(l) && /,\s*\$?\d/.test(l)).length; return { ok: n >= 3, note: t ? `${n} prices` : 'no pi5.csv' }; } },
  { id: 'plans', text: 'Compare the paid plans of Linear, Notion and Asana: each plan name and its monthly per-user price. Save a short comparison to plans.md in your working folder.',
    check: (w) => { const t = read(w, 'plans.md') || ''; const hit = ['linear', 'notion', 'asana'].filter((x) => t.toLowerCase().includes(x)); return { ok: hit.length === 3 && /\$\s?\d/.test(t), note: t ? `${hit.length}/3 apps` : 'no plans.md' }; } },
  { id: 'report', text: 'In your working folder, make a folder called report. Create report/data.csv with 24 rows of made-up 2025 monthly sales (month, region, revenue) for two regions, use Python to chart revenue by month as report/chart.png, and write report/summary.md with total revenue per region.',
    check: (w) => { const png = fs.existsSync(path.join(w, 'report', 'chart.png')); const s = read(w, 'report/summary.md'); const csv = read(w, 'report/data.csv'); return { ok: png && !!s && (csv || '').trim().split('\n').length >= 25, note: `${png ? 'chart' : 'no chart'}, ${s ? 'summary' : 'no summary'}, ${csv ? csv.trim().split('\n').length - 1 + ' rows' : 'no csv'}` }; } },
];

async function runTask(t) {
  const { bot, chat } = await api('POST', '/api/bots', { name: `Bench ${t.id}` });
  const ws = path.join(DATA, 'computers', bot.id, 'workspace');
  const started = Date.now();
  await api('POST', `/api/chats/${chat.id}/messages`, { text: t.text });
  let asks = 0, questions = 0, sawRun = false;
  const seen = new Set();
  while (Date.now() - started < TIMEOUT) {
    await new Promise((r) => setTimeout(r, 1500));
    const st = await api('GET', '/api/state');
    for (const m of st.pending || []) {
      if (m.chat_id !== chat.id || seen.has(m.id)) continue;
      seen.add(m.id);
      if (m.card.type === 'approval') { asks++; await api('POST', `/api/cards/${m.id}`, { choice: 'allow' }).catch(() => {}); }
      else if (m.card.type === 'question') { questions++; await api('POST', `/api/cards/${m.id}`, { answer: 'Use your best judgment.' }).catch(() => {}); }
    }
    const running = (st.runs || []).some((r) => r.chatId === chat.id);
    if (running) sawRun = true;
    else if (sawRun) {
      await new Promise((r) => setTimeout(r, 2500)); // a resume may follow an error
      if (!((await api('GET', '/api/state')).runs || []).some((r) => r.chatId === chat.id)) break;
    }
  }
  const secs = Math.round((Date.now() - started) / 1000);
  const msgs = (await api('GET', `/api/chats/${chat.id}/messages?limit=50`)).messages || [];
  const finals = msgs.filter((m) => m.author === 'bot' && m.meta?.steps);
  const tools = finals.reduce((n, m) => n + m.meta.steps.filter((s) => s.k === 'tool').length, 0);
  const asksBack = finals.length && /\?\s*$/.test(finals.at(-1).text.trim());
  const errors = msgs.filter((m) => m.author === 'system' && /problem|interrupted/.test(m.text)).length;
  const result = { id: t.id, secs, tools, asks, questions, errors, endsWithQuestion: !!asksBack, model: finals.at(-1)?.meta?.model, ...t.check(ws), timedOut: Date.now() - started >= TIMEOUT };
  console.log(JSON.stringify(result));
  return result;
}

const results = [];
for (const t of TASKS.filter((x) => !ONLY || ONLY.includes(x.id))) {
  try { results.push(await runTask(t)); } catch (e) { results.push({ id: t.id, error: e.message }); console.log(t.id, 'ERROR', e.message); }
}
const ok = results.filter((r) => r.ok).length;
const sum = (k) => results.reduce((n, r) => n + (r[k] || 0), 0);
const summary = { passed: `${ok}/${results.length}`, totalSecs: sum('secs'), totalTools: sum('tools'), totalAsks: sum('asks'), totalQuestions: sum('questions') };
console.log(JSON.stringify(summary));
if (OUT) fs.writeFileSync(OUT, JSON.stringify({ summary, results }, null, 2));
