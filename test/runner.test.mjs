process.env.LIGHT_REPORT_CONFIG_DIR ||= (await import('node:fs')).mkdtempSync((await import('node:path')).join((await import('node:os')).tmpdir(), 'lr-cfg-'));
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseLightFile, detectCommand, cleanEnv, createRunner } from '../lib/runner.mjs';
import { createApp } from '../server.mjs';

const root = mkdtempSync(join(tmpdir(), 'lr-git-'));
function makeRepo(owner, name, files) {
  const d = join(root, 'work', owner, name);
  mkdirSync(d, { recursive: true });
  for (const [f, c] of Object.entries(files)) writeFileSync(join(d, f), c);
  const g = (...a) => execFileSync('git', a, { cwd: d, stdio: 'ignore' });
  g('init', '-q', '-b', 'main'); g('add', '-A');
  g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'x');
  mkdirSync(join(root, 'bare', owner), { recursive: true });
  execFileSync('git', ['clone', '-q', '--bare', d, join(root, 'bare', owner, name)], { stdio: 'ignore' });
}
makeRepo('o', 'lit', { 'light.yml': '# demo\nrun: echo hello\nrun: test 1 -eq 1\n' });
makeRepo('o', 'dark', { '.light': 'run: echo nope && exit 3\n' });
makeRepo('o', 'slow', { '.light': 'run: sleep 30\n' });
makeRepo('o', 'none', { 'README.md': 'hi' });
const gitBase = 'file://' + join(root, 'bare') + '/';

test('light file format', () => {
  assert.deepEqual(parseLightFile('# c\n\nrun: npm ci\n- run: "npm test"\nother: x\n'), ['npm ci', 'npm test']);
});
test('command detection', () => {
  const d = mkdtempSync(join(tmpdir(), 'lr-d-'));
  assert.equal(detectCommand(d).command, null);
  writeFileSync(join(d, 'Makefile'), 'test:\n\ttrue\n');
  assert.equal(detectCommand(d).command, 'make test');
  writeFileSync(join(d, 'requirements.txt'), '');
  assert.match(detectCommand(d).command, /pytest/);
  writeFileSync(join(d, 'Cargo.toml'), '');
  assert.equal(detectCommand(d, { hasCargo: true }).command, 'cargo test');
  assert.equal(detectCommand(d, { hasCargo: false }).command, null);
  writeFileSync(join(d, 'package.json'), '{"scripts":{"test":"x"}}');
  assert.match(detectCommand(d).command, /npm install .*&& npm test/);
  writeFileSync(join(d, 'package-lock.json'), '{}');
  assert.match(detectCommand(d).command, /^npm ci/);
  writeFileSync(join(d, '.light'), 'run: echo custom\n');
  assert.equal(detectCommand(d).command, 'echo custom');
});
test('child env has no secrets', () => {
  process.env.RAILWAY_TOKEN = 'x'; process.env.GITHUB_TOKEN = 'y'; process.env.SOME_SECRET = 'z';
  const e = cleanEnv('/tmp/h');
  assert.ok(!Object.keys(e).some((k) => /RAILWAY|TOKEN|SECRET/.test(k)));
  assert.equal(e.HOME, '/tmp/h');
});

let server, base;
before(async () => {
  server = createApp({ ttlSeconds: 3600, runsPerHour: 100, runnerOptions: { gitBase, timeoutMs: 2000 } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());
const waitDone = async (id) => { for (;;) { const v = await (await fetch(`${base}/runs/${id}`)).json(); if (v.status === 'done') return v; await new Promise((r) => setTimeout(r, 50)); } };
const submit = async (body) => (await fetch(`${base}/runs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();

test('lit run, log, and light on the board', async () => {
  const r = await submit({ repo: 'o/lit' });
  const log = await (await fetch(`${base}/runs/${r.id}/log`)).text();
  assert.match(log, /hello/);
  assert.match(log, /● lit/);
  const v = await waitDone(r.id);
  assert.deepEqual([v.light, v.bit, v.exitCode, v.detected], ['lit', 0, 0, 'light.yml']);
  const l = await (await fetch(`${base}/lights/o--lit`)).json();
  assert.deepEqual([l.light, l.source], ['lit', 'light-report-runner']);
  assert.equal((await fetch(`${base}/lights/o--lit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"exitCode":1}' })).status, 401);
});
test('dark run, timeout, no command, bad clone, explicit command', async () => {
  const dark = await waitDone((await submit({ repo: 'o/dark' })).id);
  assert.deepEqual([dark.light, dark.exitCode], ['dark', 3]);
  const slow = await waitDone((await submit({ repo: 'o/slow' })).id);
  assert.deepEqual([slow.light, slow.timedOut], ['dark', true]);
  const none = await waitDone((await submit({ repo: 'o/none' })).id);
  assert.equal(none.light, 'dark'); assert.match(none.error, /no test command/);
  const missing = await waitDone((await submit({ repo: 'o/missing' })).id);
  assert.equal(missing.light, 'dark'); assert.match(missing.error, /clone/);
  const cmd = await waitDone((await submit({ repo: 'o/none', command: 'test -f README.md' })).id);
  assert.equal(cmd.light, 'lit');
  assert.equal((await fetch(`${base}/runs`, { method: 'POST', body: '{"repo":"../x"}' })).status, 400);
  assert.equal((await fetch(`${base}/runs`, { method: 'POST', body: '{"repo":"o/lit","ref":"--upload-pack=x"}' })).status, 400);
});
test('output cap', async () => {
  const r = createRunner({ gitBase, logCap: 200 });
  const run = r.submit({ repo: 'o/none', command: 'yes | head -c 100000' });
  await new Promise((res) => run.events.once('done', res));
  assert.ok(run.logBytes < 400);
  assert.equal(run.light, 'lit');
});
test('rate limit', async () => {
  const s = createApp({ runsPerHour: 1, runnerOptions: { gitBase } });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const u = `http://127.0.0.1:${s.address().port}/runs`;
  const p = () => fetch(u, { method: 'POST', body: JSON.stringify({ repo: 'o/lit' }) });
  assert.equal((await p()).status, 202);
  assert.equal((await p()).status, 429);
  await new Promise((r) => setTimeout(r, 500));
  s.close();
});
test('light-check streams, prints status, exits 0 lit / 1 dark', async () => {
  const bin = fileURLToPath(new URL('../bin/light-check.mjs', import.meta.url));
  const run = (args) => new Promise((resolve) => {
    const c = spawn(process.execPath, [bin, ...args], { env: { ...process.env, LIGHT_REPORT_URL: base }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    c.stdout.on('data', (d) => (out += d)); c.stderr.on('data', (d) => (err += d));
    c.on('exit', (status) => resolve({ status, out, err }));
  });
  let r = await run(['o/lit']);
  assert.equal(r.status, 0); assert.match(r.out, /hello/); assert.match(r.err, /◌ running…/); assert.match(r.err, /● lit/);
  r = await run(['o/dark']);
  assert.equal(r.status, 1); assert.match(r.err, /○ dark/);
  r = await run(['bad']);
  assert.equal(r.status, 2);
});
