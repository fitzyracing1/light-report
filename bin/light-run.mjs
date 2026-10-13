#!/usr/bin/env node
// light-run <name> -- <command...>
// Runs the command, reports its exit code as a light (0 → lit, else → dark), and exits with the same code.
//   LIGHT_REPORT_URL   server base URL (default https://light-report-production.up.railway.app)
//   LIGHT_TOKEN        write token for this light (or LIGHT_TOKEN_<NAME>); first report prints a new one
//   LIGHT_SOURCE       source label (default "light-run@<hostname>")
import { spawn } from 'node:child_process';
import { hostname } from 'node:os';
import { loadToken, saveToken } from '../lib/local.mjs';

const args = process.argv.slice(2);
const sep = args.indexOf('--');
const name = args[0];
const cmd = sep >= 0 ? args.slice(sep + 1) : [];
if (!name || name === '--' || sep !== 1 || cmd.length === 0) {
  console.error('usage: light-run <name> -- <command> [args...]');
  process.exit(2);
}
const base = (process.env.LIGHT_REPORT_URL || 'https://light-report-production.up.railway.app').replace(/\/+$/, '');
const envKey = 'LIGHT_TOKEN_' + name.toUpperCase().replace(/[^A-Z0-9]/g, '_');
const token = process.env[envKey] || process.env.LIGHT_TOKEN || loadToken(base, name);
const started = Date.now();

const child = spawn(cmd[0], cmd.slice(1), { stdio: 'inherit', shell: cmd.length === 1 });
let reported = false;
const finish = async (code, why) => {
  if (reported) return; reported = true;
  const exitCode = code;
  const detail = `${cmd.join(' ').slice(0, 200)} → exit ${exitCode}${why ? ` (${why})` : ''} in ${((Date.now() - started) / 1000).toFixed(1)}s`;
  try {
    const res = await fetch(`${base}/lights/${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ exitCode, source: process.env.LIGHT_SOURCE || `light-run@${hostname()}`, detail }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) console.error(`light-run: report not accepted: HTTP ${res.status} ${body.error || ''}`);
    else {
      console.error(`light-run: ${name} ${body.light === 'lit' ? '●' : '○'} ${body.light} (bit ${body.bit}) → ${base}/lights/${name}`);
      if (body.token) { try { saveToken(base, name, body.token); } catch {} }
      if (body.token) console.error(`light-run: new write token for "${name}" (shown once; also saved to ~/.config/light-report/tokens.json): ${body.token}\n  export ${envKey}=${body.token}`);
    }
  } catch (e) {
    console.error(`light-run: could not reach ${base}: ${e.message}`);
  }
  process.exit(exitCode);
};
child.on('error', (e) => finish(127, e.message));
child.on('exit', (code, sig) => finish(code ?? 1, sig ? `signal ${sig}` : ''));
