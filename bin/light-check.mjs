#!/usr/bin/env node
// light-check owner/repo [--ref x] [--cmd '...']   run the repo's tests on a light-report runner, stream the log
// light-check owner/repo --github                  read the repo's current GitHub light (lit-dark rule)
// Exit: 0 lit, 1 dark, 2 usage or transport error (that is not a light).
import { readGitHubLight } from '../lib/github.mjs';

const argv = process.argv.slice(2);
const opt = { ref: null, cmd: null, github: false, repo: null };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--ref') opt.ref = argv[++i];
  else if (a === '--cmd') opt.cmd = argv[++i];
  else if (a === '--github') opt.github = true;
  else if (!a.startsWith('-') && !opt.repo) opt.repo = a;
  else { opt.repo = null; break; }
}
if (!opt.repo || !/^[\w.-]+\/[\w.-]+$/.test(opt.repo)) {
  console.error("usage: light-check owner/repo [--ref branch-or-tag] [--cmd 'shell command']\n       light-check owner/repo --github");
  process.exit(2);
}
const base = (process.env.LIGHT_REPORT_URL || 'https://light-report-production.up.railway.app').replace(/\/+$/, '');
const tty = process.stderr.isTTY;
const status = (s) => process.stderr.write(tty ? `\r\x1b[2K${s}` : `${s}\n`);
const lamp = (l) => (l === 'lit' ? '● lit' : '○ dark');

try {
  if (opt.github) {
    const r = await readGitHubLight(opt.repo);
    console.log(`${lamp(r.state)}  bit=${r.state === 'lit' ? 0 : 1}  ${opt.repo}  (github: ${r.detail})`);
    process.exit(r.state === 'lit' ? 0 : 1);
  }
  const res = await fetch(`${base}/runs`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repo: opt.repo, ref: opt.ref || undefined, command: opt.cmd || undefined }),
  });
  const run = await res.json().catch(() => ({}));
  if (!res.ok) { console.error(`light-check: run not accepted: HTTP ${res.status} ${run.error || ''}`); process.exit(2); }
  status(`◌ running…  ${opt.repo}  ${base}/runs/${run.id}\n`);
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
  status(`${lamp(final.light)}  bit=${final.bit}  ${opt.repo}  exit ${final.exitCode}${final.timedOut ? ' (timeout)' : ''} in ${final.seconds}s  ${base}/lights/${final.lightName}\n`);
  process.exit(final.light === 'lit' ? 0 : 1);
} catch (e) {
  console.error(`light-check: ${e.message}`);
  process.exit(2);
}
