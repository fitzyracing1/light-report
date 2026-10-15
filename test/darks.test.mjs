import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lightsForRepo, pickCause, classify, mergeState, issueBody, isIgnoredWorkflow } from '../lib/darks.mjs';
import { createGitHub, syncIssues, seedRepos, queueMarkdown } from '../bin/dark-crawl.mjs';
import { darksHtml, darksJson } from '../lib/darks-board.mjs';
import { createApp } from '../server.mjs';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const now = Date.parse('2026-10-13T12:00:00Z');
const ago = (d) => new Date(now - d * 86400_000).toISOString();
const W = [
  { id: 1, name: 'CI', path: '.github/workflows/ci.yml', state: 'active' },
  { id: 2, name: 'Nightly', path: '.github/workflows/nightly.yml', state: 'active' },
  { id: 3, name: 'pages-build-deployment', path: 'dynamic/pages/pages-build-deployment', state: 'active' },
  { id: 4, name: 'CodeQL', path: 'dynamic/github-code-scanning/codeql', state: 'active' },
  { id: 5, name: 'Old', path: '.github/workflows/old.yml', state: 'active' },
  { id: 6, name: 'Off', path: '.github/workflows/off.yml', state: 'disabled_manually' },
];
const files = new Set(['.github/workflows/ci.yml', '.github/workflows/nightly.yml', '.github/workflows/off.yml']);
const run = (id, wf, conclusion, d, event = 'push', branch = 'main') => ({ id, workflow_id: wf, conclusion, created_at: ago(d), event, head_branch: branch, status: 'completed', html_url: `u/${id}` });

test('strict rule per workflow', () => {
  const runs = [
    run(1, 1, 'failure', 1), run(2, 1, 'failure', 2), run(3, 1, 'success', 3), // CI dark since day 2
    run(4, 1, 'success', 0.5, 'pull_request'),                                 // PR runs don't count
    run(5, 1, 'success', 0.2, 'push', 'feature'),                              // other branches don't count
    run(6, 2, 'failure', 5, 'schedule'), run(7, 2, 'success', 4, 'schedule'),  // newer lit wins
    run(8, 3, 'failure', 1), run(9, 4, 'failure', 1),                          // ignored
    run(10, 5, 'failure', 1),                                                  // workflow file gone
    run(11, 6, 'failure', 1),                                                  // disabled
    run(12, 1, 'failure', 40),
  ];
  const ls = lightsForRepo({ workflows: W, files, runs, branch: 'main', now });
  assert.deepEqual(ls.map((l) => [l.workflow, l.light]).sort(), [['CI', 'dark'], ['Nightly', 'lit']]);
  const ci = ls.find((l) => l.workflow === 'CI');
  assert.equal(ci.darkSince, ago(2)); assert.equal(ci.darkRuns, 2); assert.ok(ci.lastLitAt !== null);
  assert.equal(lightsForRepo({ workflows: W, files, runs: [run(1, 1, 'cancelled', 1)], branch: 'main', now })[0].light, 'dark');
  assert.equal(lightsForRepo({ workflows: W, files, runs: [run(1, 1, 'failure', 31)], branch: 'main', now }).length, 0);
  assert.ok(isIgnoredWorkflow({ name: 'Dependabot Updates', path: 'dynamic/dependabot/dependabot-updates' }));
});
test('cause and class', () => {
  assert.equal(pickCause({ annotations: [{ annotation_level: 'failure', message: 'Process completed with exit code 1.' }, { annotation_level: 'failure', message: 'TypeError: x is undefined\nmore', path: 'src/a.js', start_line: 3 }] }), 'TypeError: x is undefined (src/a.js:3)');
  assert.match(pickCause({ annotations: [{ annotation_level: 'failure', message: 'Process completed with exit code 2.' }], failedStep: 'Run tests', failedJob: 'test' }), /step "Run tests" in job "test"/);
  assert.equal(classify({ cause: 'TypeError: x', conclusion: 'failure' }), 'code bug');
  assert.equal(classify({ cause: 'x', conclusion: 'cancelled' }), 'infra');
  assert.equal(classify({ cause: 'No space left on device', conclusion: 'failure' }), 'infra');
  assert.equal(classify({ cause: 'npm ERR! 404 Not Found', conclusion: 'failure' }), 'external');
  assert.equal(classify({ cause: 'Timeout of 2000ms exceeded', conclusion: 'failure' }), 'flaky');
});
test('merge: new, override, queue, relit, gone', () => {
  const lights = (light, d = 1) => [{ workflow: 'CI', path: '.github/workflows/ci.yml', light, darkSince: ago(d), conclusion: light === 'dark' ? 'failure' : 'success', cause: 'boom', class: 'code bug', run: { url: 'u', startedAt: ago(0) } }];
  let s = mergeState({ darks: {} }, new Map([['o/a', { stars: 5, lights: lights('dark') }], ['o/b', { stars: 9, lights: lights('dark') }]]), { now });
  assert.equal(s.darks['o/a#.github/workflows/ci.yml'].status, 'new');
  s = mergeState(s, new Map([['o/a', { stars: 5, lights: lights('dark', 3) }]]), { now, overrides: { 'o/a#.github/workflows/ci.yml': 'fix-trying' }, queued: [{ key: 'o/b#.github/workflows/ci.yml' }] });
  assert.equal(s.darks['o/a#.github/workflows/ci.yml'].status, 'fix-trying');
  assert.equal(s.darks['o/a#.github/workflows/ci.yml'].darkSince, ago(1), 'dark since kept');
  assert.equal(s.darks['o/b#.github/workflows/ci.yml'].status, 'PR-queued');
  s = mergeState(s, new Map([['o/a', { stars: 5, lights: lights('lit') }], ['o/b', { stars: 9, lights: [] }]]), { now });
  assert.deepEqual([s.darks['o/a#.github/workflows/ci.yml'].status, s.darks['o/a#.github/workflows/ci.yml'].light], ['relit', 'lit']);
  assert.equal(s.darks['o/b#.github/workflows/ci.yml'].status, 'relit');
  s = mergeState(s, new Map([['o/a', { stars: 5, lights: lights('dark') }]]), { now });
  assert.equal(s.darks['o/a#.github/workflows/ci.yml'].status, 'new', 'dark again after relit is new');
});
test('HARD RULE: writes outside fitzyracing1/darks are refused', async () => {
  const calls = [];
  const gh = createGitHub({ token: 't', fetchImpl: async (u, o) => { calls.push([o.method, u]); return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({}) }; } });
  assert.throws(() => gh.ownRepoWrite('POST', '/repos/facebook/react/issues', {}), /refusing/);
  assert.throws(() => gh.ownRepoWrite('POST', '/repos/fitzyracing1/darks-evil/issues', {}), /refusing/);
  assert.throws(() => gh.ownRepoWrite('POST', '/repos/someone/repo/pulls', {}), /refusing/);
  await gh.ownRepoWrite('POST', '/repos/fitzyracing1/darks/issues', {});
  assert.deepEqual(calls.map((c) => c[1]), ['https://api.github.com/repos/fitzyracing1/darks/issues']);
});
test('issue sync: create, dedupe/update, close when relit', async () => {
  const issues = []; const log = [];
  const gh = {
    get: async (p) => { assert.match(p, /^\/repos\/fitzyracing1\/darks\/issues\?/); return issues; },
    ownRepoWrite: async (m, p, b) => {
      log.push(`${m} ${p}`);
      if (m === 'POST' && p.endsWith('/issues')) { const i = { number: issues.length + 1, state: 'open', ...b, labels: b.labels.map((name) => ({ name })) }; issues.push(i); return i; }
      if (m === 'PATCH') { const i = issues.find((x) => p.endsWith('/' + x.number)); Object.assign(i, b, { labels: (b.labels || []).map((name) => ({ name })) }); return i; }
      return {};
    },
  };
  const e = { key: 'o/a#ci', repo: 'o/a', stars: 1, workflow: 'CI', path: 'ci', light: 'dark', status: 'new', class: 'code bug', cause: 'x', run: 'u', darkSince: ago(1) };
  const state = { darks: { [e.key]: e } };
  assert.equal((await syncIssues(gh, state)).created, 1);
  assert.equal((await syncIssues(gh, state)).created, 0, 'no duplicate');
  assert.equal(issues.length, 1);
  Object.assign(e, { light: 'lit', status: 'relit', relitAt: ago(0), relitRun: 'u2' });
  assert.equal((await syncIssues(gh, state)).closed, 1);
  assert.equal(issues[0].state, 'closed'); assert.match(issues[0].title, /relit/);
  assert.ok(log.every((l) => l.includes('/repos/fitzyracing1/darks/')));
  assert.match(issueBody(e), /Nothing is posted to o\/a/);
});
test('seed reading is read-only and tolerant', () => {
  const d = mkdtempSync(join(tmpdir(), 'seed-'));
  writeFileSync(join(d, 'r.tsv'), 'a/b\t5\tCI\tdark\tfailure\nc/d\t5\tCI\tlit\tsuccess\n');
  writeFileSync(join(d, 'r.json'), JSON.stringify({ results: [{ repo: 'e/f', light: 'dark' }, { repo: 'g/h', light: 'lit' }] }));
  assert.deepEqual([...seedRepos([join(d, 'r.tsv'), join(d, 'r.json'), join(d, 'missing.json')]).keys()].sort(), ['a/b', 'e/f']);
});
test('board html/json and routes', async () => {
  const state = { updatedAt: ago(0), lastCrawl: { at: ago(0), scanned: 3 }, queued: [{ key: 'o/a#ci', action: 'PR: fix test' }], darks: {
    a: { key: 'a', repo: 'o/a', stars: 10, workflow: 'CI', path: 'ci', light: 'dark', status: 'new', class: 'code bug', cause: '<b>x</b>', run: 'https://x', darkSince: ago(2), issue: 4 },
    b: { key: 'b', repo: 'o/b', stars: 99, workflow: 'CI', path: 'ci', light: 'lit', status: 'relit', class: 'flaky', cause: 'y', run: 'https://y', darkSince: ago(5), relitAt: ago(1) } } };
  const j = darksJson(state);
  assert.deepEqual(j.counts, { dark: 1, relit: 1 });
  assert.match(j.darks[0].darkSinceET, /ET$/);
  const html = darksHtml(state);
  assert.match(html, /&#60;b&#62;x/); assert.match(html, /PR: fix test/); assert.match(html, /relit/);
  assert.doesNotMatch(html, /\b(green|red|pass|passed|fail|failed|failing)\b/i);
  const s = createApp({ darksSource: { load: async () => state } });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const b = `http://127.0.0.1:${s.address().port}`;
  assert.equal((await (await fetch(b + '/darks.json')).json()).counts.dark, 1);
  assert.match(await (await fetch(b + '/darks')).text(), /o\/a/);
  assert.match(await (await fetch(b + '/')).text(), /href="\/darks"/);
  s.close();
  assert.match(queueMarkdown(state.queued, state), /never sent/);
});
