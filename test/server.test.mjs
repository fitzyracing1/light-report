process.env.LIGHT_REPORT_CONFIG_DIR ||= (await import('node:fs')).mkdtempSync((await import('node:path')).join((await import('node:os')).tmpdir(), 'lr-cfg-'));
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server.mjs';

const dir = mkdtempSync(join(tmpdir(), 'lr-'));
let server, base;
before(async () => {
  server = createApp({ dataDir: dir, ttlSeconds: 3600, github: async (repo) => ({ state: repo === 'o/lit' ? 'success' : 'failure', source: 'github', detail: repo }) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());
const post = (p, body, token) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });

test('first report creates light and returns token once; token required after', async () => {
  let r = await post('/lights/build', { exitCode: 0, source: 'test' });
  assert.equal(r.status, 201);
  const j = await r.json();
  assert.equal(j.light, 'lit'); assert.equal(j.bit, 0); assert.ok(j.token);
  assert.ok(!readFileSync(join(dir, 'lights.json'), 'utf8').includes(j.token), 'token stored hashed');
  r = await post('/lights/build', { exitCode: 1, source: 'test' });
  assert.equal(r.status, 401);
  r = await post('/lights/build', { exitCode: 1, source: 'test' }, 'wrong');
  assert.equal(r.status, 401);
  r = await post('/lights/build', { exitCode: 3, source: 'test' }, j.token);
  assert.equal(r.status, 200);
  const k = await r.json();
  assert.equal(k.light, 'dark'); assert.equal(k.token, undefined);
  assert.equal(await (await fetch(base + '/lights/build/LIGHT')).text(), 'dark\n');
  const g = await (await fetch(base + '/lights/build')).json();
  assert.deepEqual([g.name, g.light, g.bit, g.source, g.stale], ['build', 'dark', 1, 'test', false]);
  const svg = await fetch(base + '/lights/build/badge.svg');
  assert.match(svg.headers.get('content-type'), /svg/);
  assert.match(await svg.text(), /dark/);
  const home = await (await fetch(base + '/')).text();
  for (const id of ['lights', 'ways', 'quickstart', 'report', 'run', 'agents', 'light-file', 'badge', 'api', 'detect', 'limits', 'faq']) assert.match(home, new RegExp(`id="${id}"`));
  assert.match(home, /build/);
  assert.doesNotMatch(home, /\b(green|red|pass|passed|fail|failed|failure)\b/i);
  assert.match(await (await fetch(base + '/board')).text(), /build/);
});
test('unknown light has no light (404), not dark', async () => {
  const res = await fetch(base + '/lights/never');
  assert.equal(res.status, 404);
  const g = await res.json();
  assert.deepEqual([g.light, g.bit, g.stale], [null, null, false]);
  const l = await fetch(base + '/lights/never/LIGHT');
  assert.equal(l.status, 404);
  assert.match(await (await fetch(base + '/lights/never/badge.svg')).text(), /no light/);
});
test('state reports and bad input', async () => {
  assert.equal((await (await post('/lights/s1', { state: 'lit', source: 'x' })).json()).light, 'lit');
  assert.equal((await post('/lights/s2', { source: 'x' })).status, 400);
  assert.equal((await post('/lights/bad%20name', { exitCode: 0 })).status, 400);
});
test('github adapter endpoint', async () => {
  assert.equal((await (await post('/lights/gh/github', { repo: 'o/lit' })).json()).light, 'lit');
});
test('persists across restart', async () => {
  const s2 = createApp({ dataDir: dir, ttlSeconds: 3600 });
  await new Promise((r) => s2.listen(0, '127.0.0.1', r));
  const g = await (await fetch(`http://127.0.0.1:${s2.address().port}/lights/s1`)).json();
  s2.close();
  assert.equal(g.light, 'lit');
});
test('light-run reports the exit code and exits with it', async () => {
  const bin = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'light-run.mjs');
  const run = (name, code) => new Promise((resolve) => {
    import('node:child_process').then(({ spawn }) => {
      const c = spawn(process.execPath, [bin, name, '--', process.execPath, '-e', `process.exit(${code})`], { env: { ...process.env, LIGHT_REPORT_URL: base } , stdio: ['ignore', 'pipe', 'pipe'] });
      let err = ''; c.stderr.on('data', (d) => (err += d));
      c.on('exit', (status) => resolve({ status, err }));
    });
  });
  let r = await run('cli-lit', 0);
  assert.equal(r.status, 0); assert.match(r.err, /lit/);
  r = await run('cli-dark', 7);
  assert.equal(r.status, 7);
  assert.equal(await (await fetch(base + '/lights/cli-dark/LIGHT')).text(), 'dark\n');
  assert.equal(await (await fetch(base + '/lights/cli-lit/LIGHT')).text(), 'lit\n');
});
