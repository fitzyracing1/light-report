import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toLight, toBit, lightsToByte, view, hashToken, tokenMatches, badgeSvg } from '../lib/lights.mjs';
import { readGitHubLight } from '../lib/github.mjs';

test('exit code 0 is lit, anything else is dark', () => {
  assert.equal(toLight({ exitCode: 0 }), 'lit');
  assert.equal(toLight({ exitCode: '0' }), 'lit');
  for (const c of [1, 2, 127, -1, '1']) assert.equal(toLight({ exitCode: c }), 'dark');
});
test('state lit / github success is lit; other conclusions dark', () => {
  assert.equal(toLight({ state: 'lit' }), 'lit');
  assert.equal(toLight({ state: 'success' }), 'lit');
  for (const s of ['dark', 'failure', 'cancelled', 'timed_out', 'skipped', 'neutral']) assert.equal(toLight({ state: s }), 'dark');
});
test('active-low bit and byte', () => {
  assert.equal(toBit('lit'), 0);
  assert.equal(toBit('dark'), 1);
  assert.equal(lightsToByte(['lit','lit','lit','lit','dark','dark','lit','lit']), 12);
});
test('stale lights are dark; never-reported has no light', () => {
  const rec = { light: 'lit', source: 's', reportedAt: new Date(Date.now() - 10_000).toISOString() };
  assert.equal(view('a', rec, 60_000).light, 'lit');
  const v = view('a', rec, 5_000);
  assert.deepEqual([v.light, v.bit, v.stale], ['dark', 1, true]);
  assert.equal(view('none', undefined, 5_000).light, null);
});
test('token hashing', () => {
  const h = hashToken('abc');
  assert.ok(tokenMatches('abc', h));
  assert.ok(!tokenMatches('abd', h));
  assert.ok(!tokenMatches(undefined, h));
});
test('badge says lit or dark', () => {
  assert.match(badgeSvg('x', 'lit'), /lit/);
  assert.match(badgeSvg('x', 'dark'), /dark/);
});
test('github adapter uses the lit-dark rule', async () => {
  const fake = (conclusion) => async () => ({ ok: true, json: async () => ({ workflow_runs: conclusion ? [{ conclusion, name: 'ci', html_url: 'u' }] : [] }) });
  assert.equal((await readGitHubLight('a/b', { fetchImpl: fake('success') })).state, 'lit');
  assert.equal((await readGitHubLight('a/b', { fetchImpl: fake('failure') })).state, 'dark');
  await assert.rejects(readGitHubLight('a/b', { fetchImpl: fake(null) }), /no completed/);
});
