// Behavior changes from moving light-report and dark-crawl onto @fitzyracing1/light-core (see MIGRATION.md).
process.env.LIGHT_REPORT_CONFIG_DIR ||= (await import('node:fs')).mkdtempSync((await import('node:path')).join((await import('node:os')).tmpdir(), 'lr-cfg-'));
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toLight, lightsToByte, LightError } from '../lib/lights.mjs';
import { readGitHubLight } from '../lib/github.mjs';
import { createGitHub, scanRepo } from '../bin/dark-crawl.mjs';
import { createApp } from '../server.mjs';

const res = (status, body, headers = {}) => ({
  ok: status >= 200 && status < 300, status,
  headers: { get: (k) => headers[k.toLowerCase()] ?? null },
  json: async () => body, text: async () => JSON.stringify(body),
});

test('change 2: a report with no data or an unknown word is an error, not dark', () => {
  for (const r of [{}, { exitCode: '' }, { exitCode: 'x' }, { exitCode: ' ' }, { state: '' }, { state: 'passed' }, { state: 'green' }])
    assert.throws(() => toLight(r), LightError, JSON.stringify(r));
});

let server, base;
before(async () => {
  server = createApp({ dataDir: mkdtempSync(join(tmpdir(), 'lr-core-')), ttlSeconds: 3600, github: async () => ({ state: 'lit' }) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());
const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('change 2: the server answers 400 for a report it cannot read, and records nothing', async () => {
  for (const body of [{ state: 'green' }, { exitCode: 'x' }, { exitCode: '' }]) {
    const r = await post('/lights/bad-report', body);
    assert.equal(r.status, 400, JSON.stringify(body));
  }
  assert.equal((await fetch(base + '/lights/bad-report')).status, 404);
});

test('change 3: packing refuses more than 8 lights or a non-light', () => {
  assert.equal(lightsToByte(['lit', 'lit', 'lit', 'lit', 'dark', 'dark', 'lit', 'lit']), 12);
  assert.throws(() => lightsToByte(Array(9).fill('lit')));
  assert.throws(() => lightsToByte(['lit', undefined]));
  assert.throws(() => lightsToByte(['lit', 'green']));
});

test('change 6: the GitHub adapter waits out retry-after instead of failing', async () => {
  const waits = []; let n = 0;
  const fetchImpl = async () => (n++ === 0
    ? res(429, { message: 'slow down' }, { 'retry-after': '3' })
    : res(200, { workflow_runs: [{ status: 'completed', conclusion: 'success', name: 'ci', html_url: 'u' }] }));
  const r = await readGitHubLight('a/b', { fetchImpl, sleep: async (ms) => { waits.push(ms); } });
  assert.equal(r.state, 'lit');
  assert.deepEqual(waits, [3000]);
});

test('change 6: dark-crawl stops with a budget error when the reset is far away', async () => {
  const far = String(Math.floor(Date.now() / 1000) + 3600);
  const gh = createGitHub({ token: 't', sleep: async () => {}, fetchImpl: async () => res(403, { message: 'rate limit' }, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': far }) });
  await assert.rejects(gh.get('/repos/o/r'), (e) => e.budget === true);
  // and refuses further calls until the reset
  await assert.rejects(gh.get('/repos/o/s'), (e) => e.budget === true);
});

test('change 6: a plain 403 is not a rate limit', async () => {
  const gh = createGitHub({ token: 't', sleep: async () => {}, fetchImpl: async () => res(403, { message: 'Resource not accessible' }) });
  await assert.rejects(gh.get('/repos/o/r'), (e) => e.status === 403 && !e.budget);
});

test('dark-crawl search calls are still paced', async () => {
  const waits = [];
  const gh = createGitHub({ token: 't', sleep: async (ms) => { waits.push(ms); }, fetchImpl: async () => res(200, { items: [] }) });
  await gh.get('/search/repositories?q=x');
  assert.deepEqual(waits, [2200]);
  assert.equal(gh.st.searchCalls, 1);
  assert.equal(gh.st.calls, 1);
});

const now = Date.parse('2026-10-13T12:00:00Z');
const ago = (d) => new Date(now - d * 86400_000).toISOString();
function fakeRepo({ runs, meta = {} }) {
  const calls = [];
  const gh = {
    get: async (p) => {
      calls.push(p);
      if (p === '/repos/o/r') return { default_branch: 'main', stargazers_count: 7, ...meta };
      if (p.startsWith('/repos/o/r/actions/workflows')) return { workflows: [
        { id: 1, name: 'CI', path: '.github/workflows/ci.yml', state: 'active' },
        { id: 2, name: 'pages-build-deployment', path: 'dynamic/pages/pages-build-deployment', state: 'active' },
      ] };
      if (p.startsWith('/repos/o/r/contents/')) return [{ path: '.github/workflows/ci.yml' }];
      if (p.startsWith('/repos/o/r/actions/runs?')) return { workflow_runs: runs };
      if (/\/jobs\?/.test(p)) return { jobs: [] };
      throw new Error(`unexpected ${p}`);
    },
  };
  return { gh, calls };
}
const run = (id, wf, conclusion, created, extra = {}) => ({ id, workflow_id: wf, conclusion, status: 'completed', event: 'push', head_branch: 'main', created_at: created, html_url: `u/${id}`, ...extra });

test('change 5: a re-run decides by its latest attempt and run_started_at', async () => {
  // run 1 was created 40 days ago (outside the window by created_at) and re-run lit 1 day ago
  const { gh } = fakeRepo({ runs: [
    run(2, 1, 'failure', ago(3)),
    run(1, 1, 'failure', ago(40), { run_attempt: 1 }),
    run(1, 1, 'success', ago(40), { run_attempt: 2, run_started_at: ago(1) }),
  ] });
  const r = await scanRepo(gh, 'o/r', { now });
  assert.equal(r.lights.length, 1);
  assert.deepEqual([r.lights[0].light, r.lights[0].run.id, r.lights[0].run.attempt], ['lit', 1, 2]);
});

test('change 4: Pages runs never decide; repo meta is read once; field renames', async () => {
  const { gh, calls } = fakeRepo({ runs: [run(5, 2, 'failure', ago(1)), run(6, 1, 'failure', ago(2)), run(7, 1, 'success', ago(4))] });
  const r = await scanRepo(gh, 'o/r', { now });
  assert.equal(r.stars, 7);
  assert.deepEqual(r.lights.map((l) => [l.workflow, l.light, l.darkRuns, l.run.startedAt]), [['CI', 'dark', 1, ago(2)]]);
  assert.ok(r.lights[0].lastLitAt !== null);
  assert.equal(r.lights[0].streak, undefined);
  assert.equal(calls.filter((p) => p === '/repos/o/r').length, 1);
});

test('archived and disabled repos are skipped', async () => {
  assert.equal((await scanRepo(fakeRepo({ runs: [], meta: { archived: true } }).gh, 'o/r', { now })).skipped, 'archived');
  assert.equal((await scanRepo(fakeRepo({ runs: [], meta: { disabled: true } }).gh, 'o/r', { now })).skipped, 'disabled');
});
