// runner.mjs — tiny build/test runner: shallow-clone a PUBLIC GitHub repo, run its tests,
// record the exit code as a light (0 → lit, anything else → dark, timeout → dark).
// NOT a full sandbox: the child runs as an unprivileged user in a wiped temp dir with a clean env,
// a hard timeout and an output cap, but shares the container's kernel and network.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync, chownSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';

export const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;
export const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/;

/** light name for a repo: owner/name → owner--name */
export const repoLightName = (repo) => repo.replace('/', '--');

/** Parse the light file format: one `run: <shell command>` per line; `#` comments and blank lines ignored. */
export function parseLightFile(text) {
  const cmds = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^-?\s*run:\s*(.+)$/.exec(line);
    if (m) cmds.push(m[1].trim().replace(/^(['"])(.*)\1$/, '$2'));
  }
  return cmds;
}

/** Pick the command for a checked-out repo dir. Returns { command, why } or { command: null, why }. */
export function detectCommand(dir, { hasCargo = false } = {}) {
  const has = (f) => existsSync(join(dir, f));
  for (const f of ['light.yml', 'light.yaml', '.light']) {
    if (has(f)) {
      const cmds = parseLightFile(readFileSync(join(dir, f), 'utf8'));
      if (cmds.length) return { command: cmds.join(' && '), why: f };
    }
  }
  if (has('package.json')) {
    let pkg = {};
    try { pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')); } catch {}
    if (pkg.scripts?.test) {
      const install = has('package-lock.json') || has('npm-shrinkwrap.json') ? 'npm ci' : 'npm install';
      return { command: `${install} --no-audit --no-fund && npm test`, why: 'package.json scripts.test' };
    }
  }
  if (has('Cargo.toml')) {
    if (hasCargo) return { command: 'cargo test', why: 'Cargo.toml' };
    return { command: null, why: 'Cargo.toml found but no Rust toolchain on this runner' };
  }
  if (has('pyproject.toml') || has('setup.py') || has('requirements.txt')) {
    const steps = ['python3 -m venv .lr-venv', '. .lr-venv/bin/activate', 'pip install -q --upgrade pip'];
    if (has('requirements.txt')) steps.push('pip install -q -r requirements.txt');
    if (has('pyproject.toml') || has('setup.py')) steps.push('pip install -q -e .');
    steps.push('pip install -q pytest', 'pytest');
    return { command: steps.join(' && '), why: 'python project' };
  }
  for (const mk of ['Makefile', 'makefile', 'GNUmakefile']) {
    if (has(mk) && /^test\s*:/m.test(readFileSync(join(dir, mk), 'utf8'))) return { command: 'make test', why: `${mk} test target` };
  }
  return { command: null, why: 'no light.yml/.light, package.json test, Cargo.toml, python project or Makefile test target' };
}

const SAFE_ENV = ['PATH', 'LANG', 'LC_ALL', 'TZ'];
export function cleanEnv(home) {
  const env = { HOME: home, CI: 'true', LIGHT_REPORT_RUNNER: '1', GIT_TERMINAL_PROMPT: '0', npm_config_cache: join(home, '.npm'), PIP_CACHE_DIR: join(home, '.pip'), PIP_DISABLE_PIP_VERSION_CHECK: '1' };
  for (const k of SAFE_ENV) if (process.env[k]) env[k] = process.env[k];
  env.PATH ||= '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
  return env;
}

export function createRunner({
  onResult = () => {},
  maxConcurrent = Number(process.env.RUN_CONCURRENCY || 1),
  maxQueue = Number(process.env.RUN_MAX_QUEUE || 10),
  timeoutMs = Number(process.env.RUN_TIMEOUT_SECONDS || 600) * 1000,
  logCap = Number(process.env.RUN_LOG_BYTES || 1_000_000),
  keep = 100,
  uid = process.env.RUN_AS_UID ? Number(process.env.RUN_AS_UID) : undefined,
  gid = process.env.RUN_AS_GID ? Number(process.env.RUN_AS_GID) : undefined,
  gitBase = process.env.RUN_GIT_BASE || 'https://github.com/',
  hasCargo = undefined,
} = {}) {
  const runs = new Map();
  const queue = [];
  let active = 0;
  const runAs = typeof process.getuid === 'function' && process.getuid() === 0 && uid !== undefined ? { uid, gid: gid ?? uid } : {};
  if (hasCargo === undefined) hasCargo = (process.env.PATH || '').split(':').some((p) => existsSync(join(p, 'cargo')));

  function append(run, s) {
    if (run.logBytes >= logCap) return;
    let chunk = String(s);
    if (run.logBytes + Buffer.byteLength(chunk) > logCap) chunk = chunk.slice(0, logCap - run.logBytes) + `\n[light-report: log cut at ${logCap} bytes]\n`;
    run.logBytes += Buffer.byteLength(chunk);
    run.log.push(chunk);
    run.events.emit('data', chunk);
  }

  function exec(run, cmd, args, opts) {
    return new Promise((resolve) => {
      const child = spawn(cmd, args, { ...opts, ...runAs, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      run.child = child;
      child.stdout.on('data', (d) => append(run, d));
      child.stderr.on('data', (d) => append(run, d));
      child.on('error', (e) => { append(run, `[light-report: ${e.message}]\n`); resolve(127); });
      child.on('close', (code, sig) => { run.child = null; resolve(code ?? (sig ? 128 + 9 : 1)); });
    });
  }

  function killRun(run) {
    if (run.child?.pid) { try { process.kill(-run.child.pid, 'SIGKILL'); } catch {} }
  }

  async function execute(run) {
    run.status = 'running';
    run.startedAt = new Date().toISOString();
    const dir = mkdtempSync(join(tmpdir(), 'lr-run-'));
    if (runAs.uid !== undefined) chownSync(dir, runAs.uid, runAs.gid);
    const env = cleanEnv(dir);
    const timer = setTimeout(() => { run.timedOut = true; append(run, `\n[light-report: timeout after ${timeoutMs / 1000}s, stopping]\n`); killRun(run); }, timeoutMs);
    let exitCode = 1;
    try {
      append(run, `$ git clone --depth 1 ${run.ref ? `--branch ${run.ref} ` : ''}${run.repo}\n`);
      const cloneArgs = ['clone', '--depth', '1', '--no-tags', ...(run.ref ? ['--branch', run.ref] : []), gitBase + run.repo + (gitBase.startsWith('https://') ? '.git' : ''), 'src'];
      exitCode = await exec(run, 'git', cloneArgs, { cwd: dir, env });
      if (exitCode !== 0 || run.timedOut) { run.error = 'clone did not work (public repos and branch/tag refs only)'; }
      else {
        const src = join(dir, 'src');
        let command = run.command;
        if (!command) {
          const d = detectCommand(src, { hasCargo });
          run.detected = d.why;
          command = d.command;
        }
        if (!command) { run.error = `no test command: ${run.detected}`; append(run, `[light-report: ${run.error}]\n`); exitCode = 1; }
        else {
          run.command = command;
          append(run, `$ ${command}\n`);
          exitCode = await exec(run, 'sh', ['-c', command], { cwd: src, env });
        }
      }
    } catch (e) {
      run.error = e.message; append(run, `[light-report: ${e.message}]\n`); exitCode = 1;
    } finally {
      clearTimeout(timer);
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    }
    if (run.timedOut) exitCode = exitCode || 124;
    run.exitCode = exitCode;
    run.light = exitCode === 0 && !run.timedOut ? 'lit' : 'dark';
    run.bit = run.light === 'lit' ? 0 : 1;
    run.status = 'done';
    run.finishedAt = new Date().toISOString();
    run.seconds = (Date.parse(run.finishedAt) - Date.parse(run.startedAt)) / 1000;
    append(run, `\n[light-report: exit ${exitCode} → ${run.light === 'lit' ? '● lit' : '○ dark'}]\n`);
    try { onResult(run); } catch (e) { console.error('runner onResult:', e.message); }
    run.events.emit('done');
  }

  function pump() {
    while (active < maxConcurrent && queue.length) {
      const run = queue.shift();
      active++;
      execute(run).finally(() => { active--; pump(); });
    }
  }

  function submit({ repo, ref, command }) {
    if (!REPO_RE.test(String(repo || ''))) throw Object.assign(new Error('repo must look like owner/name (public GitHub repo)'), { code: 400 });
    if (ref != null && ref !== '' && !REF_RE.test(String(ref))) throw Object.assign(new Error('ref must be a branch or tag name'), { code: 400 });
    if (command != null && (typeof command !== 'string' || command.length > 2000)) throw Object.assign(new Error('command must be a string up to 2000 chars'), { code: 400 });
    if (queue.length >= maxQueue) throw Object.assign(new Error('queue is full, try again later'), { code: 503 });
    const id = randomBytes(6).toString('hex');
    const run = { id, repo, ref: ref || null, command: command || null, light: null, bit: null, exitCode: null, status: 'queued', queuedAt: new Date().toISOString(), log: [], logBytes: 0, events: new EventEmitter() };
    run.events.setMaxListeners(100);
    runs.set(id, run);
    while (runs.size > keep) { const [old] = runs.keys(); if (runs.get(old).status !== 'done') break; runs.delete(old); }
    queue.push(run);
    pump();
    return run;
  }

  const view = (run) => ({
    id: run.id, repo: run.repo, ref: run.ref, status: run.status, light: run.light, bit: run.bit, exitCode: run.exitCode,
    command: run.command, detected: run.detected ?? null, timedOut: !!run.timedOut, error: run.error ?? null,
    queuedAt: run.queuedAt, startedAt: run.startedAt ?? null, finishedAt: run.finishedAt ?? null, seconds: run.seconds ?? null,
    lightName: repoLightName(run.repo),
  });

  return { submit, get: (id) => runs.get(id), view, list: () => [...runs.values()].map(view).reverse(), stop: () => { for (const r of runs.values()) killRun(r); } };
}
