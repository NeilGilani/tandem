// Thin wrapper around the Claude Code CLI you're already signed in to.
import { spawn } from 'node:child_process';
import { PATHS } from './db.js';

export const CLAUDE_BIN = process.env.TANDEM_CLAUDE || 'claude';

// Environment for every Claude Code child: no inherited session markers.
export function childEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const k of Object.keys(env)) if (k.startsWith('CLAUDECODE') || k === 'CLAUDE_CODE_ENTRYPOINT') delete env[k];
  return env;
}

// One-shot helper call (routing, triage, schedules, Auto Review): no tools, small model.
export function quick(prompt, { model = 'haiku', system, timeoutMs = 90000 } = {}) {
  return new Promise((resolve, reject) => {
    const args = ['-p', prompt, '--model', model, '--output-format', 'json', '--tools', '',
      '--setting-sources', '', '--strict-mcp-config', '--no-session-persistence'];
    if (system) args.push('--system-prompt', system);
    const child = spawn(CLAUDE_BIN, args, { cwd: PATHS.runtime, env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const t = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('Claude helper timed out')); }, timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => {
      clearTimeout(t);
      try {
        const j = JSON.parse(out);
        if (j.is_error) return reject(new Error(j.result || 'Claude error'));
        resolve(String(j.result || '').trim());
      } catch { reject(new Error(err.trim() || `claude exited ${code}`)); }
    });
  });
}

export async function quickJson(prompt, opts) {
  const text = await quick(prompt, opts);
  const m = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
  if (!m) throw new Error(`Expected JSON, got: ${text.slice(0, 200)}`);
  return JSON.parse(m[0]);
}
