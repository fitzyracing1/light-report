process.env.LIGHT_REPORT_CONFIG_DIR ||= (await import('node:fs')).mkdtempSync((await import('node:path')).join((await import('node:os')).tmpdir(), 'lr-cfg-'));
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { listFiles, packDir, localLightName, isExcluded } from '../lib/local.mjs';
import { init, upsertBlock } from '../lib/init.mjs';
import { unpackFiles } from '../lib/runner.mjs';
import { createApp } from '../server.mjs';

const bin = fileURLToPath(new URL('../bin/light-check.mjs', import.meta.url));
const tmp = (p) => mkdtempSync(join(tmpdir(), p));
function folder(files, git = false) {
  const d = tmp('lr-f-');
  for (const [f, c] of Object.entries(files)) { mkdirSync(join(d, f, '..'), { recursive: true }); writeFileSync(join(d, f), c); }
  if (git) execFileSync('git', ['init', '-q'], { cwd: d });
  return d;
}
let server, base;
before(async () => {
  server = createApp({ runsPerHour: 100 });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());
const cli = (args, { cwd, input } = {}) => new Promise((resolve) => {
  const c = spawn(process.execPath, [bin, ...args], { cwd, env: { ...process.env, LIGHT_REPORT_URL: base }, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '', err = '';
  c.stdout.on('data', (d) => (out += d)); c.stderr.on('data', (d) => (err += d));
  c.stdin.end(input || '');
  c.on('exit', (status) => resolve({ status, out, err }));
});

test('packing respects .gitignore and always excludes secrets', () => {
  const d = folder({ 'a.js': '1', '.gitignore': 'dist/\n', 'dist/x.js': '2', '.env': 'S=1', '.env.local': 'S', 'k.pem': 'x', 'node_modules/m/i.js': 'x', 'sub/id_rsa': 'x', 'sub/ok.txt': 'y' }, true);
  const files = listFiles(d).sort();
  assert.deepEqual(files, ['.gitignore', 'a.js', 'sub/ok.txt']);
  const plain = folder({ 'a.js': '1', '.env': 'S', 'node_modules/x': 'x', '.git/config': 'x' });
  assert.deepEqual(listFiles(plain).sort(), ['a.js']);
  assert.ok(isExcluded('x/.env.production') && isExcluded('server.key') && !isExcluded('src/env.js'));
  assert.throws(() => packDir(folder({ 'big.bin': 'x'.repeat(2000) }), { maxBytes: 1000 }), /over/);
  assert.equal(localLightName('/tmp/My App'), 'local--My-App');
});
test('unpack rejects path escapes', () => {
  const d = tmp('lr-u-');
  assert.throws(() => unpackFiles(join(d, 's'), [{ path: '../x', data: '' }]), /bad path/);
  assert.throws(() => unpackFiles(join(d, 's'), [{ path: '/etc/x', data: '' }]), /bad path/);
  assert.throws(() => unpackFiles(join(d, 's'), [{ path: '.git/hooks/x', data: '' }]), /bad path/);
  assert.equal(unpackFiles(join(d, 's'), [{ path: 'a/b.txt', data: Buffer.from('hi').toString('base64') }]), 1);
  assert.equal(readFileSync(join(d, 's/a/b.txt'), 'utf8'), 'hi');
});
test('light-check . uploads and runs on the server: lit and dark', async () => {
  const lit = folder({ '.light': 'run: test -f a.txt\n', 'a.txt': 'x', '.env': 'SECRET=1' });
  let r = await cli(['.', '--name', 'up-lit'], { cwd: lit });
  assert.equal(r.status, 0, r.err); assert.match(r.err, /● lit/);
  const dark = folder({ '.light': 'run: test -f .env\n', '.env': 'SECRET=1' }); // .env is never uploaded → dark
  r = await cli([dark, '--name', 'up-dark']);
  assert.equal(r.status, 1); assert.match(r.err, /○ dark/);
  const l = await (await fetch(`${base}/lights/up-dark`)).json();
  assert.deepEqual([l.light, l.source], ['dark', 'light-report-runner (upload)']);
});
test('light-check --local runs here and reports, token reused', async () => {
  const lit = folder({ 'package.json': '{"scripts":{"test":"node -e 0"}}' });
  let r = await cli(['.', '--local'], { cwd: lit });
  assert.equal(r.status, 0, r.err); assert.match(r.err, /● lit/);
  const name = localLightName(lit);
  assert.equal(await (await fetch(`${base}/lights/${name}/LIGHT`)).text(), 'lit\n');
  writeFileSync(join(lit, 'package.json'), '{"scripts":{"test":"node -e process.exit(4)"}}');
  r = await cli(['.', '--local'], { cwd: lit });
  assert.equal(r.status, 1); assert.match(r.err, /○ dark/);
  assert.equal(await (await fetch(`${base}/lights/${name}/LIGHT`)).text(), 'dark\n', 'second report used the saved token');
  r = await cli(['.', '--local', '--no-report', '--cmd', 'true'], { cwd: lit });
  assert.equal(r.status, 0);
});
test('Claude Code stop hook: lit lets Claude stop, dark blocks with reason, gives up after 8', async () => {
  const lit = folder({ '.light': 'run: echo all good\n' });
  let r = await cli(['--hook', 'claude-stop'], { input: JSON.stringify({ cwd: lit, session_id: 's-lit', hook_event_name: 'Stop' }) });
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.out).decision, undefined);
  const dark = folder({ '.light': 'run: echo broken thing && exit 1\n' });
  const sid = 's-dark-' + Date.now();
  r = await cli(['--hook', 'claude-stop'], { input: JSON.stringify({ cwd: dark, session_id: sid }) });
  assert.equal(r.status, 0);
  const j = JSON.parse(r.out);
  assert.equal(j.decision, 'block'); assert.match(j.reason, /dark/); assert.match(j.reason, /broken thing/);
  for (let i = 0; i < 8; i++) r = await cli(['--hook', 'claude-stop'], { input: JSON.stringify({ cwd: dark, session_id: sid }) });
  assert.equal(JSON.parse(r.out).decision, undefined);
  r = await cli(['--hook', 'claude-post-edit'], { input: JSON.stringify({ cwd: dark }) });
  assert.equal(r.status, 2); assert.match(r.err, /dark/);
});
test('init writes all integrations, merges, and is idempotent', async () => {
  const d = folder({
    '.claude/settings.json': JSON.stringify({ permissions: { allow: ['Bash(ls)'] }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] } }),
    '.vscode/tasks.json': JSON.stringify({ version: '2.0.0', tasks: [{ label: 'build', type: 'shell', command: 'make' }] }),
    'AGENTS.md': '# Agents\n\nBe nice.\n',
  }, true);
  let r = await cli(['init', '--pre-push', '--post-edit'], { cwd: d });
  assert.equal(r.status, 0, r.err);
  const s = JSON.parse(readFileSync(join(d, '.claude/settings.json'), 'utf8'));
  assert.deepEqual(s.permissions, { allow: ['Bash(ls)'] });
  assert.equal(s.hooks.Stop.length, 2);
  assert.match(s.hooks.Stop[1].hooks[0].command, /light-check --hook claude-stop/);
  assert.equal(s.hooks.PostToolUse[0].matcher, 'Edit|Write|MultiEdit');
  const t = JSON.parse(readFileSync(join(d, '.vscode/tasks.json'), 'utf8'));
  assert.deepEqual(t.tasks.map((x) => x.label), ['build', 'light-check']);
  assert.match(readFileSync(join(d, 'AGENTS.md'), 'utf8'), /^# Agents[\s\S]*Be nice\.[\s\S]*light-check:start/);
  for (const f of ['CLAUDE.md', '.github/copilot-instructions.md', '.cursor/rules/light-check.mdc', '.git/hooks/pre-push']) assert.ok(existsSync(join(d, f)), f);
  assert.ok(statSync(join(d, '.git/hooks/pre-push')).mode & 0o100);
  const snap = () => ['.claude/settings.json', '.vscode/tasks.json', 'AGENTS.md', 'CLAUDE.md', '.github/copilot-instructions.md', '.cursor/rules/light-check.mdc', '.git/hooks/pre-push'].map((f) => readFileSync(join(d, f), 'utf8'));
  const first = snap();
  r = await cli(['init', '--pre-push', '--post-edit'], { cwd: d });
  assert.deepEqual(snap(), first, 'second init changes nothing');
  assert.match(r.out, /unchanged/);
  const words = first.join('\n');
  assert.doesNotMatch(words, /\b(green|red|pass|passed|passes|fail|failed|failing|failure)\b/i);
});
test('init leaves JSON with comments alone', async () => {
  const d = folder({ '.vscode/tasks.json': '// my tasks\n{"version":"2.0.0","tasks":[]}' });
  const r = await cli(['init'], { cwd: d });
  assert.match(r.out, /skipped\s+\.vscode\/tasks\.json/);
  assert.match(readFileSync(join(d, '.vscode/tasks.json'), 'utf8'), /^\/\/ my tasks/);
});
test('upsertBlock replaces in place', () => {
  const a = upsertBlock('x\n', 'one');
  const b = upsertBlock(a, 'two');
  assert.match(b, /^x\n\n<!-- light-check:start -->\ntwo\n<!-- light-check:end -->\n$/);
});
