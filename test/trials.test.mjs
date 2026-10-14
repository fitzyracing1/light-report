import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRouter } from '../lib/router.mjs';
import { pickEvictions, trialLight, trialService, siteNameFor } from '../lib/trial.mjs';
import { parseTrialArgs, trialCli } from '../lib/trial-cli.mjs';
import { runLightName } from '../lib/runner.mjs';

const TOKEN = 'admin-secret-for-tests';
const lights = { 'o--r--trial-aaa': 'lit', 'o--r--trial-bbb': 'dark' };
const upstreams = [];
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${srv.address().port}`)));
const copy = (label) => createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end(`${label} ${req.method} ${req.url}`); });
let live, trA, trB, router, base, dir;
before(async () => {
  for (const l of ['LIVE', 'TRIAL-A', 'TRIAL-B']) { const s = copy(l); upstreams.push(s); }
  [live, trA, trB] = await Promise.all(upstreams.map(listen));
  dir = mkdtempSync(join(tmpdir(), 'lr-site-'));
  router = createRouter({ dataDir: dir, adminToken: TOKEN, defaultSite: 'r', fetchLight: async (n) => lights[n] || 'dark', seed: { r: { live } } });
  base = await listen(router);
});
after(() => { router.close(); upstreams.forEach((s) => s.close()); });
const call = (method, p, body, tok = TOKEN) => fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: `Bearer ${tok}` } : {}) }, body: body ? JSON.stringify(body) : undefined });

test('stable URL proxies to live; flip to a lit trial, back to live (rollback)', async () => {
  assert.match(await (await fetch(base + '/x?y=1')).text(), /^LIVE GET \/x\?y=1/);
  assert.equal((await call('POST', '/sites/r/trials', { id: 'aaa', url: trA, light: 'o--r--trial-aaa' })).status, 201);
  let r = await call('POST', '/sites/r/flip', { to: 'aaa' });
  assert.equal(r.status, 200); assert.equal((await r.json()).target, 'aaa');
  const page = await fetch(base + '/');
  assert.match(await page.text(), /^TRIAL-A/); assert.equal(page.headers.get('x-light-site'), 'r:aaa');
  r = await call('POST', '/sites/r/flip', { to: 'live' });
  assert.equal(r.status, 200);
  assert.match(await (await fetch(base + '/')).text(), /^LIVE/);
  assert.ok(JSON.parse(readFileSync(join(dir, 'sites.json'), 'utf8')).sites.r, 'persisted');
});

test('dark trial refused unless force; cap of 2 trials; admin token required', async () => {
  assert.equal((await call('POST', '/sites/r/trials', { id: 'bbb', url: trB, light: 'o--r--trial-bbb' })).status, 201);
  let r = await call('POST', '/sites/r/flip', { to: 'bbb' });
  assert.equal(r.status, 409); assert.equal((await r.json()).light, 'dark');
  assert.match(await (await fetch(base + '/')).text(), /^LIVE/);
  r = await call('POST', '/sites/r/flip', { to: 'bbb', force: true });
  assert.equal(r.status, 200);
  assert.match(await (await fetch(base + '/')).text(), /^TRIAL-B/);
  assert.equal((await call('POST', '/sites/r/trials', { id: 'ccc', url: trB })).status, 409, 'cap');
  assert.equal((await call('POST', '/sites/r/flip', { to: 'live' }, null)).status, 401);
  assert.equal((await call('POST', '/sites/r/flip', { to: 'live' }, 'wrong')).status, 401);
  assert.equal((await call('POST', '/sites/r/flip', { to: 'nope' })).status, 404);
  // removing the current target falls back to live
  assert.equal((await call('DELETE', '/sites/r/trials/bbb')).status, 200);
  const s = await (await fetch(base + '/sites/r')).json();
  assert.equal(s.target, 'live'); assert.deepEqual(s.trials.map((t) => t.id), ['aaa']);
  assert.ok(!JSON.stringify(s).includes(TOKEN));
  assert.match(await (await fetch(base + '/')).text(), /^LIVE/);
});

test('bad input on the router', async () => {
  assert.equal((await call('PUT', '/sites/r', { live: 'ftp://x' })).status, 400);
  assert.equal((await call('POST', '/sites/r/trials', { id: 'live', url: trA })).status, 400);
  assert.equal((await call('POST', '/sites/r/trials', { id: 'ok', url: 'javascript:1' })).status, 400);
  assert.equal((await call('GET', '/sites/Bad_Name')).status, 400);
});

test('trial helpers: names, light names, evictions', () => {
  assert.equal(trialLight('o/r', 'abc'), 'o--r--trial-abc');
  assert.equal(runLightName('o/r', 'trial/abc'), 'o--r--trial-abc');
  assert.equal(runLightName('o/r', 'main'), 'o--r');
  assert.equal(runLightName('o/r'), 'o--r');
  assert.equal(trialService('fitzyracing1/light-report', 'abc'), 'light-report-trial-abc');
  assert.equal(siteNameFor('o/My.Repo'), 'my-repo');
  const t = (id, at) => ({ id, createdAt: at });
  assert.deepEqual(pickEvictions({ target: 'live', trials: [t('b', '2'), t('a', '1')] }).map((x) => x.id), ['a']);
  assert.deepEqual(pickEvictions({ target: 'a', trials: [t('b', '2'), t('a', '1')] }).map((x) => x.id), ['b']);
  assert.deepEqual(pickEvictions({ target: 'live', trials: [t('a', '1')] }), []);
});

test('CLI args and flip via the CLI', async () => {
  assert.throws(() => parseTrialArgs(['trial', 'o/r']), /--merge/);
  assert.equal(parseTrialArgs(['trial', 'o/r', '--merge', 'pr:3']).merge, 'pr:3');
  assert.equal(parseTrialArgs(['flip', 's', 'live', '--force']).force, true);
  const out = [], err = [];
  const env = { LIGHT_SITE_URL: base, LIGHT_SITE_ADMIN_TOKEN: TOKEN };
  assert.equal(await trialCli(['flip', 'r', 'aaa'], env, (m) => out.push(m), (m) => err.push(m)), 0);
  assert.match(await (await fetch(base + '/')).text(), /^TRIAL-A/);
  assert.equal(await trialCli(['site', 'r'], env, (m) => out.push(m), (m) => err.push(m)), 0);
  assert.match(out.join('\n'), /stable URL → aaa/);
  assert.equal(await trialCli(['flip', 'r', 'live'], env, (m) => out.push(m), (m) => err.push(m)), 0);
  assert.equal(await trialCli(['flip', 'r', 'live'], { LIGHT_SITE_URL: base }, () => {}, () => {}), 2, 'no token');
  assert.ok(!out.join('').includes(TOKEN) && !err.join('').includes(TOKEN));
});
