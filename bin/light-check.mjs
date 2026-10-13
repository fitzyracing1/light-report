#!/usr/bin/env node
// light-check — get a lit / dark light for a repo or a local folder.
//   light-check owner/repo [--ref x] [--cmd '...']   server clones a public repo and runs its tests
//   light-check owner/repo --github                  read the repo's current GitHub light
//   light-check [path] [--name n] [--cmd '...']      upload the working tree (default path: .) and run it on the server
//   light-check [path] --local [--no-report]          run the detected command here, report the light (nothing uploaded)
//   light-check init [--post-edit] [--pre-push] [--folder-open]   add Claude Code / VS Code / Cursor / git integration
//   light-check --hook claude-stop|claude-post-edit  used by Claude Code hooks
// Exit: 0 lit, 1 dark, 2 usage or transport error (that is not a light).
import { existsSync, statSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir, hostname } from 'node:os';
import { readGitHubLight } from '../lib/github.mjs';
import { DEFAULT_URL, packDir, localLightName, reportLight, runLocal } from '../lib/local.mjs';
import { init } from '../lib/init.mjs';
import { gzipSync } from 'node:zlib';

const argv = process.argv.slice(2);
const opt = { target: null, ref: null, cmd: null, name: null, github: false, local: false, report: true, hook: null, postEdit: false, prePush: false, folderOpen: false };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--ref') opt.ref = argv[++i];
  else if (a === '--cmd') opt.cmd = argv[++i];
  else if (a === '--name') opt.name = argv[++i];
  else if (a === '--github') opt.github = true;
  else if (a === '--local') opt.local = true;
  else if (a === '--no-report') opt.report = false;
  else if (a === '--hook') opt.hook = argv[++i];
  else if (a === '--post-edit') opt.postEdit = true;
  else if (a === '--pre-push') opt.prePush = true;
  else if (a === '--folder-open') opt.folderOpen = true;
  else if (a === '-h' || a === '--help') { usage(0); }
  else if (!a.startsWith('-') && opt.target === null) opt.target = a;
  else { console.error(`light-check: unknown argument ${a}`); usage(2); }
}
function usage(code) {
  console.error(`usage:
  light-check owner/repo [--ref branch-or-tag] [--cmd 'shell command']   run a public GitHub repo on the server
  light-check owner/repo --github                                       read its GitHub light
  light-check [path] [--name light-name] [--cmd '...']                  upload a local folder (default .) and run it on the server
  light-check [path] --local [--no-report]                              run it here, nothing uploaded
  light-check init [--post-edit] [--pre-push] [--folder-open]           add agent integration to this repo
exit: 0 lit, 1 dark, 2 error`);
  process.exit(code);
}
const base = (process.env.LIGHT_REPORT_URL || DEFAULT_URL).replace(/\/+$/, '');
const tty = process.stderr.isTTY;
const status = (s) => process.stderr.write(tty ? `\r\x1b[2K${s}` : `${s}\n`);
const lamp = (l) => (l === 'lit' ? '● lit' : '○ dark');
const REPO = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;

async function streamRun(run, label) {
  status(`◌ running…  ${label}  ${base}/runs/${run.id}\n`);
  const log = await fetch(`${base}/runs/${run.id}/log`);
  const dec = new TextDecoder();
  for await (const chunk of log.body) process.stdout.write(dec.decode(chunk, { stream: true }));
  let final;
  for (let i = 0; i < 30; i++) {
    final = await (await fetch(`${base}/runs/${run.id}`)).json();
    if (final.status === 'done') break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (final.status !== 'done') { console.error('light-check: run did not finish'); process.exit(2); }
  status(`${lamp(final.light)}  bit=${final.bit}  ${label}  exit ${final.exitCode}${final.timedOut ? ' (timeout)' : ''} in ${final.seconds}s  ${base}/lights/${final.lightName}\n`);
  process.exit(final.light === 'lit' ? 0 : 1);
}

async function submit(path, body, headers = { 'Content-Type': 'application/json' }) {
  const res = await fetch(`${base}${path}`, { method: 'POST', headers, body });
  const run = await res.json().catch(() => ({}));
  if (!res.ok) { console.error(`light-check: run not accepted: HTTP ${res.status} ${run.error || ''}`); process.exit(2); }
  return run;
}

/** Local run: returns { light, exitCode, log } ; prints log via out. */
async function localCheck(dir, out) {
  const name = opt.name || localLightName(dir);
  const t0 = Date.now();
  const r = await runLocal(dir, { command: opt.cmd || undefined, out });
  const light = r.exitCode === 0 ? 'lit' : 'dark';
  let reported = '';
  if (opt.report) {
    try {
      await reportLight(base, name, { exitCode: r.exitCode, source: `light-check --local@${hostname()}`, detail: `${r.command || r.why} → exit ${r.exitCode} in ${((Date.now() - t0) / 1000).toFixed(1)}s` });
      reported = `  ${base}/lights/${name}`;
    } catch (e) { reported = `  (light not reported: ${e.message})`; }
  }
  return { light, exitCode: r.exitCode, reported, name };
}

try {
  // Claude Code hooks: never print anything but JSON on stdout.
  if (opt.hook) {
    let input = {};
    try { input = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch {}
    const dir = input.cwd || process.env.CLAUDE_PROJECT_DIR || '.';
    let log = '';
    const out = (c) => { log += c; if (log.length > 400000) log = log.slice(-200000); };
    const r = await localCheck(dir, out);
    const tail = log.split('\n').slice(-60).join('\n').slice(-6000);
    const stateDir = join(tmpdir(), 'light-check-hooks'); mkdirSync(stateDir, { recursive: true });
    const counter = join(stateDir, String(input.session_id || 'none').replace(/[^\w-]/g, '_'));
    if (r.light === 'lit') {
      try { writeFileSync(counter, '0'); } catch {}
      if (opt.hook === 'claude-stop') process.stdout.write(JSON.stringify({ systemMessage: `light-check: ● lit${r.reported}` }) + '\n');
      process.exit(0);
    }
    if (opt.hook === 'claude-post-edit') {
      process.stderr.write(`light-check: ○ dark (exit ${r.exitCode}) after this edit. Last lines:\n${tail}\n`);
      process.exit(2); // PostToolUse: stderr is shown to Claude; the edit already happened
    }
    // claude-stop: send Claude back to work while dark, but give up after 8 rounds in one session
    let n = 0; try { n = Number(readFileSync(counter, 'utf8')) || 0; } catch {}
    n++; try { writeFileSync(counter, String(n)); } catch {}
    if (n > 8) {
      process.stdout.write(JSON.stringify({ systemMessage: `light-check: still ○ dark after ${n - 1} rounds; letting Claude stop. Check it yourself.${r.reported}` }) + '\n');
      process.exit(0);
    }
    process.stdout.write(JSON.stringify({
      decision: 'block',
      reason: `light-check is ○ dark (exit ${r.exitCode}, round ${n} of 8). The project's tests did not run clean. Read the log below, fix the cause (do not skip or weaken tests), and finish only when \`light-check . --local\` is lit.\n\n--- last lines ---\n${tail}`,
    }) + '\n');
    process.exit(0);
  }

  if (opt.target === 'init') {
    const log = init(process.cwd(), { postEdit: opt.postEdit, prePush: opt.prePush, folderOpen: opt.folderOpen });
    console.log(`light-check init in ${process.cwd()}\n  ${log.join('\n  ')}\nNext: commit these files. Claude Code, VS Code (Copilot) and Cursor will run light-check before finishing.`);
    process.exit(0);
  }

  const target = opt.target ?? '.';
  const isDir = existsSync(target) && statSync(target).isDirectory();

  if (opt.github || (!isDir && REPO.test(target))) {
    if (!REPO.test(target)) usage(2);
    if (opt.github) {
      const r = await readGitHubLight(target);
      console.log(`${lamp(r.state)}  bit=${r.state === 'lit' ? 0 : 1}  ${target}  (github: ${r.detail})`);
      process.exit(r.state === 'lit' ? 0 : 1);
    }
    const run = await submit('/runs', JSON.stringify({ repo: target, ref: opt.ref || undefined, command: opt.cmd || undefined }));
    await streamRun(run, target);
  }

  if (!isDir) { console.error(`light-check: ${target} is not a folder or owner/repo`); usage(2); }
  const dir = resolve(target);

  if (opt.local) {
    status(`◌ running…  ${dir}  (local)\n`);
    const r = await localCheck(dir, (c) => process.stdout.write(c));
    status(`${lamp(r.light)}  bit=${r.light === 'lit' ? 0 : 1}  ${r.name}  exit ${r.exitCode}${r.reported}\n`);
    process.exit(r.light === 'lit' ? 0 : 1);
  }

  const name = opt.name || localLightName(dir);
  const pack = packDir(dir);
  status(`light-check: uploading ${pack.files.length} files (${(pack.total / 1024).toFixed(0)} KB) as light "${name}"\n`);
  const gz = gzipSync(Buffer.from(JSON.stringify({ name, command: opt.cmd || undefined, files: pack.files })));
  const run = await submit('/runs/upload', gz, { 'Content-Type': 'application/gzip' });
  await streamRun(run, `${name} (upload)`);
} catch (e) {
  console.error(`light-check: ${e.message}`);
  process.exit(2);
}
