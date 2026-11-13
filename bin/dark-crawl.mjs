#!/usr/bin/env node
// dark-crawl — scan popular GitHub repos for dark lights and keep fitzyracing1/darks up to date.
//
// HARD RULE: this program never writes to any repo except DARKS_REPO (default fitzyracing1/darks).
// Every write goes through ownRepoWrite(), which refuses any other repo. Upstream actions are only
// written to queued.json / QUEUE.md for Joshua's approval; nothing is sent.
//
//   GITHUB_TOKEN=... node bin/dark-crawl.mjs [--dir .] [--max-repos 120] [--no-issues] [--seed file ...] [--dry-run]
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createGitHub as coreGitHub, readRepoLights } from '@fitzyracing1/light-core';
import { pickCause, classify, mergeState, issueTitle, issueBody, labelsFor, keyOf } from '../lib/darks.mjs';

export const DARKS_REPO = process.env.DARKS_REPO || 'fitzyracing1/darks';

/**
 * light-core's client (403/429 retry-after, x-ratelimit-reset backoff, budget floor) with dark-crawl's
 * search pacing on top. Writes only go through ownRepoWrite → light-core write() with writeRepos: [DARKS_REPO].
 */
export function createGitHub({ token = process.env.GITHUB_TOKEN, fetchImpl = fetch, floor = 60, log = console.error, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const core = coreGitHub({ token, fetch: (...a) => fetchImpl(...a), userAgent: 'dark-crawler', floor, log, sleep, writeRepos: [DARKS_REPO] });
  const st = {
    searchCalls: 0,
    get calls() { return core.rate.calls; },
    get remaining() { return core.rate.remaining; },
    get reset() { return core.rate.resetAt; },
  };
  async function get(path) {
    if (path.startsWith('/search/')) { st.searchCalls++; await sleep(2200); } // search: 30/min
    return core.get(path);
  }
  // The only door to writes. Refuses anything outside DARKS_REPO.
  const ownRepoWrite = (method, path, body) => core.write(method, path, body);
  return { get, ownRepoWrite, st };
}

// ---------- candidate sources ----------
export const TOP_NPM = ['react', 'lodash', 'axios', 'express', 'typescript', 'chalk', 'commander', 'debug', 'vue', 'next', 'webpack', 'eslint', 'prettier', 'jest', 'vite', 'rxjs', 'moment', 'dayjs', 'uuid', 'yargs', 'zod', 'tailwindcss', 'esbuild', 'rollup', 'babel-loader', 'mocha', 'socket.io', 'ws', 'dotenv', 'glob', 'semver', 'fs-extra', 'body-parser', 'cors', 'jsonwebtoken', 'mongoose', 'sequelize', 'prisma', 'redux', 'svelte', 'angular', 'three', 'd3', 'puppeteer', 'playwright', 'cheerio', 'node-fetch', 'undici', 'pino', 'winston'];
async function npmRepo(pkg, fetchImpl = fetch) {
  try {
    const j = await (await fetchImpl(`https://registry.npmjs.org/${encodeURIComponent(pkg)}/latest`)).json();
    const u = typeof j.repository === 'string' ? j.repository : j.repository?.url || '';
    const m = /github\.com[/:]([\w.-]+)\/([\w.-]+?)(\.git)?(#.*)?$/.exec(u);
    return m ? `${m[1]}/${m[2]}` : null;
  } catch { return null; }
}
export async function candidates(gh, { perSource = 40, fetchImpl = fetch } = {}) {
  const out = new Map(); // repo → source
  const add = (r, s) => { if (r && !out.has(r)) out.set(r, s); };
  const since = (d) => new Date(Date.now() - d * 86400_000).toISOString().slice(0, 10);
  const searches = [
    ['most-starred', `stars:>40000 archived:false`],
    ['trending', `created:>${since(60)} stars:>1500 archived:false`],
    ['active-popular', `pushed:>${since(3)} stars:>10000 archived:false`],
    ['mcp', `topic:mcp-server archived:false`],
    ['mcp', `mcp server in:name,description stars:>500 archived:false`],
  ];
  for (const [src, q] of searches) {
    try {
      const j = await gh.get(`/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=${Math.min(100, perSource)}`);
      for (const it of j.items || []) add(it.full_name, src);
    } catch (e) { if (e.budget) break; console.error(`source ${src}: ${e.message}`); }
  }
  for (const p of TOP_NPM.slice(0, perSource)) add(await npmRepo(p, fetchImpl), 'top-npm');
  return out;
}

/** Seed repos from earlier scans (read-only). Supports results.tsv (repo\tstars\tworkflow\tlit|dark...) and JSON reports. */
export function seedRepos(files) {
  const out = new Map();
  for (const f of files) {
    if (!existsSync(f)) continue;
    const text = readFileSync(f, 'utf8');
    if (f.endsWith('.tsv')) {
      for (const line of text.split('\n')) { const c = line.split('\t'); if (c[3] === 'dark' && /^[\w.-]+\/[\w.-]+$/.test(c[0])) out.set(c[0], 'seed'); }
    } else if (f.endsWith('.json')) {
      try {
        const walk = (v) => { if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') { const r = v.repo || v.full_name || v.repository; const st = String(v.light || v.state || v.status || ''); if (typeof r === 'string' && /^[\w.-]+\/[\w.-]+$/.test(r) && (!st || /dark/.test(st))) out.set(r, 'seed'); Object.values(v).forEach(walk); } };
        walk(JSON.parse(text));
      } catch {}
    } else {
      for (const m of text.matchAll(/github\.com\/([\w.-]+\/[\w.-]+)/g)) out.set(m[1].replace(/\.git$/, ''), 'seed');
    }
  }
  return out;
}

// ---------- scanning ----------
export async function scanRepo(gh, repo, { now = Date.now() } = {}) {
  // readRepoLights reads /repos/{repo} too; share the one response so stars cost no extra call.
  const metaPath = `/repos/${repo}`;
  const meta = await gh.get(metaPath);
  const read = await readRepoLights({ ...gh, get: (p) => (p === metaPath ? meta : gh.get(p)) }, repo, { now });
  if (read.skipped) return { stars: meta.stargazers_count, lights: [], skipped: read.skipped };
  const lights = read.lights;
  for (const l of lights) {
    if (l.light !== 'dark') continue;
    try {
      const jobs = await gh.get(`/repos/${repo}/actions/runs/${l.run.id}/jobs?filter=latest&per_page=50`);
      const job = (jobs.jobs || []).find((j) => j.conclusion && j.conclusion !== 'success' && j.conclusion !== 'skipped' && j.conclusion !== 'neutral');
      const step = job?.steps?.find((s) => s.conclusion === 'failure' || s.conclusion === 'timed_out' || s.conclusion === 'cancelled');
      const annotations = job ? await gh.get(`/repos/${repo}/check-runs/${job.id}/annotations?per_page=50`).catch(() => []) : [];
      l.cause = pickCause({ annotations, failedJob: job?.name, failedStep: step?.name, conclusion: l.conclusion });
    } catch (e) { if (e.budget) throw e; l.cause = `cause not readable (${e.message.slice(0, 80)})`; }
    l.class = classify({ cause: l.cause, conclusion: l.conclusion, streak: l.darkRuns, prevLit: l.lastLitAt !== null });
  }
  return { stars: meta.stargazers_count, lights };
}

// ---------- issues in DARKS_REPO only ----------
export async function syncIssues(gh, state) {
  const all = [];
  for (let page = 1; page <= 20; page++) {
    const j = await gh.get(`/repos/${DARKS_REPO}/issues?state=all&labels=dark&per_page=100&page=${page}`);
    all.push(...j.filter((i) => !i.pull_request));
    if (j.length < 100) break;
  }
  const byKey = new Map();
  for (const i of all) { const m = /<!-- dark-key: (.+?) -->/.exec(i.body || ''); if (m && !byKey.has(m[1])) byKey.set(m[1], i); }
  const counts = { created: 0, updated: 0, closed: 0, reopened: 0 };
  for (const e of Object.values(state.darks)) {
    const issue = byKey.get(e.key) || (e.issue ? all.find((i) => i.number === e.issue) : null);
    const want = { title: issueTitle(e), body: issueBody(e), labels: labelsFor(e) };
    if (e.light === 'dark') {
      if (!issue) {
        const created = await gh.ownRepoWrite('POST', `/repos/${DARKS_REPO}/issues`, want);
        e.issue = created.number; e.issueClosed = false; counts.created++;
      } else {
        e.issue = issue.number;
        const labelsNow = (issue.labels || []).map((l) => l.name).sort().join(',');
        const reopen = issue.state === 'closed';
        if (reopen || issue.title !== want.title || (issue.body || '') !== want.body || labelsNow !== [...want.labels].sort().join(',')) {
          await gh.ownRepoWrite('PATCH', `/repos/${DARKS_REPO}/issues/${issue.number}`, { ...want, ...(reopen ? { state: 'open' } : {}) });
          reopen ? counts.reopened++ : counts.updated++;
        }
        e.issueClosed = false;
      }
    } else if (issue && issue.state === 'open') {
      await gh.ownRepoWrite('PATCH', `/repos/${DARKS_REPO}/issues/${issue.number}`, { ...want, state: 'closed', state_reason: 'completed' });
      await gh.ownRepoWrite('POST', `/repos/${DARKS_REPO}/issues/${issue.number}/comments`, { body: `● relit${e.relitRun ? `: ${e.relitRun}` : ''}${e.relitNote ? ` (${e.relitNote})` : ''}. Closing.` });
      e.issue = issue.number; e.issueClosed = true; counts.closed++;
    } else if (issue) { e.issue = issue.number; e.issueClosed = true; }
  }
  return counts;
}

export function queueMarkdown(queued, state) {
  const rows = queued.map((q) => { const e = state.darks[q.key] || {}; return `| ${q.key} | ${e.light ? (e.light === 'dark' ? '○ dark' : '● lit') : '?'} | ${q.action || ''} | ${String(q.note || '').replace(/\|/g, '\\|')} | ${q.addedAt || ''} |`; });
  return `# Queued for Joshua's approval

Upstream actions (issues, PRs, comments on other people's repos) are **never sent** by the crawler. They wait here until Joshua approves and sends them himself.

| dark | light now | proposed action | note | added |
|---|---|---|---|---|
${rows.join('\n') || '| — | | nothing queued | | |'}

Edit \`queued.json\` to add entries: \`[{"key": "owner/repo#.github/workflows/ci.yml", "action": "PR: fix flaky test", "note": "...", "addedAt": "2026-10-13"}]\`.
`;
}

// ---------- main ----------
async function main() {
  const args = process.argv.slice(2);
  const opt = { dir: '.', maxRepos: 120, issues: true, seeds: [], dry: false, syncOnly: false, only: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--dir') opt.dir = args[++i];
    else if (a === '--max-repos') opt.maxRepos = Number(args[++i]);
    else if (a === '--no-issues') opt.issues = false;
    else if (a === '--seed') opt.seeds.push(args[++i]);
    else if (a === '--only') opt.only.push(args[++i]);
    else if (a === '--sync-only') opt.syncOnly = true;
    else if (a === '--dry-run') { opt.dry = true; opt.issues = false; }
    else { console.error(`unknown argument ${a}`); process.exit(2); }
  }
  const dir = resolve(opt.dir);
  const read = (f, d) => { try { return JSON.parse(readFileSync(join(dir, f), 'utf8')); } catch { return d; } };
  const prev = read('darks.json', { darks: {}, cursor: 0 });
  const overrides = read('status.json', {});
  const queued = read('queued.json', []);
  const gh = createGitHub();

  // order: open darks first (to catch relit), then seeds, then sources (rotating cursor)
  const open = [...new Set(Object.values(prev.darks || {}).filter((e) => e.light === 'dark').map((e) => e.repo))];
  const seeds = [...seedRepos(opt.seeds).keys()];
  const srcMap = opt.syncOnly || opt.only.length ? new Map() : await candidates(gh);
  const src = [...srcMap.keys()];
  const cursor = (prev.cursor || 0) % Math.max(1, src.length);
  const rotated = src.slice(cursor).concat(src.slice(0, cursor));
  const order = opt.only.length ? opt.only : opt.syncOnly ? [] : [...new Set([...open, ...seeds, ...rotated])].slice(0, opt.maxRepos);
  console.error(`dark-crawl: ${order.length} repos (open darks ${open.length}, seeds ${seeds.length}, sources ${src.length})`);

  const scanned = new Map();
  let done = 0, stopped = null;
  for (const repo of order) {
    try { scanned.set(repo, await scanRepo(gh, repo)); done++; }
    catch (e) { if (e.budget) { stopped = e.message; break; } console.error(`  ${repo}: ${e.message}`); }
  }
  const state = mergeState(prev, scanned, { overrides, queued });
  if (opt.syncOnly || opt.only.length) { state.cursor = prev.cursor || 0; state.lastCrawl = prev.lastCrawl; }
  else state.cursor = (cursor + Math.max(0, done - open.length - seeds.length)) % Math.max(1, src.length);
  if (!opt.syncOnly && !opt.only.length) state.lastCrawl = { at: new Date().toISOString(), scanned: done, darkLights: [...scanned.values()].reduce((n, r) => n + r.lights.filter((l) => l.light === 'dark').length, 0), litLights: [...scanned.values()].reduce((n, r) => n + r.lights.filter((l) => l.light === 'lit').length, 0), apiCalls: gh.st.calls, stopped };
  state.queued = queued;
  let counts = null;
  if (opt.issues) counts = await syncIssues(gh, state);
  if (state.lastCrawl) state.lastCrawl.issues = counts;
  if (!opt.dry) {
    writeFileSync(join(dir, 'darks.json'), JSON.stringify(state, null, 2) + '\n');
    writeFileSync(join(dir, 'QUEUE.md'), queueMarkdown(queued, state));
    if (!existsSync(join(dir, 'queued.json'))) writeFileSync(join(dir, 'queued.json'), '[]\n');
    if (!existsSync(join(dir, 'status.json'))) writeFileSync(join(dir, 'status.json'), '{}\n');
  }
  const darkCount = Object.values(state.darks).filter((e) => e.light === 'dark').length;
  console.error(`dark-crawl: scanned ${done}, ${darkCount} dark on the board, ${Object.values(state.darks).filter((e) => e.status === 'relit').length} relit; issues ${JSON.stringify(counts)}; ${gh.st.calls} API calls${stopped ? `; stopped early: ${stopped}` : ''}`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) main().catch((e) => { console.error(`dark-crawl: ${e.stack || e.message}`); process.exit(1); });
