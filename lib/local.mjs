// local.mjs — client-side helpers: pack a working tree, run checks locally, remember write tokens.
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, statSync, readdirSync, existsSync, lstatSync, chmodSync } from 'node:fs';
import { join, basename, resolve, relative, sep } from 'node:path';
import { homedir } from 'node:os';
import { detectCommand } from './runner.mjs';

export const DEFAULT_URL = 'https://light-report-production.up.railway.app';
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

// Never uploaded, whatever .gitignore says.
const ALWAYS_EXCLUDE = [
  /(^|\/)\.git(\/|$)/, /(^|\/)node_modules(\/|$)/, /(^|\/)\.env[^/]*$/, /\.pem$/i, /\.key$/i, /\.p12$/i, /\.pfx$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/, /(^|\/)\.npmrc$/, /(^|\/)\.netrc$/, /(^|\/)\.pypirc$/, /\.keystore$/i, /(^|\/)credentials(\.json)?$/i,
  /(^|\/)\.(venv|lr-venv)(\/|$)/, /(^|\/)__pycache__(\/|$)/,
];
export const isExcluded = (p) => ALWAYS_EXCLUDE.some((re) => re.test(p));

export const localLightName = (dir) => 'local--' + (basename(resolve(dir)).replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[^A-Za-z0-9]+/, '') || 'dir').slice(0, 90);

/** List files to send: git-tracked + untracked-not-ignored when in a git repo, else a walk; then hard excludes. */
export function listFiles(dir) {
  dir = resolve(dir);
  let files = null;
  try {
    const out = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
    files = out.toString('utf8').split('\0').filter(Boolean);
  } catch {
    files = [];
    const walk = (d) => {
      for (const e of readdirSync(join(dir, d), { withFileTypes: true })) {
        const rel = d ? `${d}/${e.name}` : e.name;
        if (isExcluded(rel) || isExcluded(rel + '/')) continue;
        if (e.isDirectory()) walk(rel); else if (e.isFile()) files.push(rel);
      }
    };
    walk('');
  }
  return files.filter((f) => !isExcluded(f.split(sep).join('/'))).filter((f) => { try { return lstatSync(join(dir, f)).isFile(); } catch { return false; } });
}

/** Pack into a gzip'd JSON bundle. Throws if the total is over the cap. */
export function packDir(dir, { maxBytes = MAX_UPLOAD_BYTES } = {}) {
  dir = resolve(dir);
  const files = [];
  let total = 0;
  for (const f of listFiles(dir)) {
    const st = statSync(join(dir, f));
    total += st.size;
    if (total > maxBytes) throw new Error(`working tree is over ${Math.round(maxBytes / 1048576)} MB after excludes; add big files to .gitignore or use --local`);
    files.push({ path: f.split(sep).join('/'), mode: st.mode & 0o111 ? 0o755 : 0o644, data: readFileSync(join(dir, f)).toString('base64') });
  }
  return { files, total };
}

// ~/.config/light-report/tokens.json : { "<url>|<name>": "lr_..." }
const tokenFile = () => join(process.env.LIGHT_REPORT_CONFIG_DIR || join(homedir(), '.config', 'light-report'), 'tokens.json');
export function loadToken(url, name) {
  try { return JSON.parse(readFileSync(tokenFile(), 'utf8'))[`${url}|${name}`]; } catch { return undefined; }
}
export function saveToken(url, name, token) {
  const f = tokenFile();
  let all = {};
  try { all = JSON.parse(readFileSync(f, 'utf8')); } catch {}
  all[`${url}|${name}`] = token;
  mkdirSync(join(f, '..'), { recursive: true });
  writeFileSync(f, JSON.stringify(all, null, 2) + '\n', { mode: 0o600 });
  try { chmodSync(f, 0o600); } catch {}
}

/** Report a light; uses env token or saved token; saves a new token. Returns the server's JSON or throws. */
export async function reportLight(url, name, { exitCode, source, detail, token }) {
  const envKey = 'LIGHT_TOKEN_' + name.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  token ||= process.env[envKey] || process.env.LIGHT_TOKEN || loadToken(url, name);
  const res = await fetch(`${url}/lights/${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ exitCode, source, detail }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`HTTP ${res.status} ${body.error || ''}`.trim());
  if (body.token) saveToken(url, name, body.token);
  return body;
}

/** Run the detected (or given) command in dir, locally. out(chunk) receives output. Resolves { exitCode, command }. */
export function runLocal(dir, { command, out = (c) => process.stdout.write(c), timeoutMs = 0 } = {}) {
  dir = resolve(dir);
  if (!command) {
    const hasCargo = (process.env.PATH || '').split(process.platform === 'win32' ? ';' : ':').some((p) => existsSync(join(p, 'cargo')));
    const d = detectCommand(dir, { hasCargo });
    if (!d.command) { out(`[light-check: no test command: ${d.why}]\n`); return Promise.resolve({ exitCode: 1, command: null, why: d.why }); }
    command = d.command;
  }
  out(`$ ${command}\n`);
  return new Promise((res) => {
    const child = spawn(command, { cwd: dir, shell: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CI: process.env.CI || 'true' } });
    let timer = timeoutMs ? setTimeout(() => { out(`\n[light-check: timeout after ${timeoutMs / 1000}s]\n`); child.kill('SIGKILL'); }, timeoutMs) : null;
    child.stdout.on('data', out); child.stderr.on('data', out);
    child.on('error', (e) => { out(`[light-check: ${e.message}]\n`); });
    child.on('close', (code) => { if (timer) clearTimeout(timer); res({ exitCode: code ?? 1, command }); });
  });
}

export { relative };
