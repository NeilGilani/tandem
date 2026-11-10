#!/usr/bin/env node
// Stdio MCP server Claude Code loads for each Bot run. It forwards every tool call
// to the Tandem daemon, tagged with the Bot, chat and run it belongs to.
import readline from 'node:readline';
import http from 'node:http';

const { TANDEM_URL, TANDEM_TOKEN, TANDEM_BOT, TANDEM_CHAT, TANDEM_RUN, TANDEM_ORIGIN, TANDEM_DEPTH, TANDEM_PREAPPROVED, TANDEM_MISSION } = process.env;
const ctx = { botId: TANDEM_BOT, chatId: TANDEM_CHAT, runId: TANDEM_RUN, origin: TANDEM_ORIGIN, depth: Number(TANDEM_DEPTH || 0), preapproved: TANDEM_PREAPPROVED === '1', missionId: TANDEM_MISSION || null };
const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${TANDEM_TOKEN}` };

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const fail = (id, message) => send({ jsonrpc: '2.0', id, error: { code: -32000, message } });

let toolsCache = null;
async function tools() {
  if (!toolsCache) toolsCache = await (await fetch(`${TANDEM_URL}/internal/tools`, { headers })).json();
  return toolsCache;
}

function post(url, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(url, { method: 'POST', headers: { ...headers, 'Content-Length': Buffer.byteLength(data) } }, (res) => {
      let out = '';
      res.on('data', (d) => (out += d));
      res.on('end', () => { try { resolve({ ok: res.statusCode < 300, status: res.statusCode, body: JSON.parse(out) }); } catch (e) { reject(e); } });
    });
    req.setTimeout(0);
    req.on('error', reject);
    req.end(data);
  });
}

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    return reply(id, {
      protocolVersion: params?.protocolVersion || '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'tandem', version: '0.1.0' },
    });
  }
  if (method === 'notifications/initialized' || method?.startsWith('notifications/')) return;
  if (method === 'ping') return reply(id, {});
  if (method === 'tools/list') return reply(id, { tools: await tools() });
  if (method === 'tools/call') {
    try {
      // Plain http (no fetch): tools like request_takeover can wait for hours.
      const r = await post(`${TANDEM_URL}/internal/call`, { tool: params.name, args: params.arguments || {}, ctx });
      const j = r.body;
      if (!r.ok) return reply(id, { content: [{ type: 'text', text: `Error: ${j?.error || r.status}` }], isError: true });
      const text = typeof j.result === 'string' ? j.result : JSON.stringify(j.result, null, 2);
      return reply(id, { content: [{ type: 'text', text: text ?? 'ok' }] });
    } catch (e) {
      return reply(id, { content: [{ type: 'text', text: `Tandem is unreachable: ${e.message}` }], isError: true });
    }
  }
  if (id !== undefined) fail(id, `Unknown method ${method}`);
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  let msg; try { msg = JSON.parse(line); } catch { return; }
  handle(msg).catch((e) => msg.id !== undefined && fail(msg.id, e.message));
});
