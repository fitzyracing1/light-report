// trial.mjs — client-side orchestration for "trial merge + rotating URL" (v1: your own repos, Railway).
//   1. duplicate: branch trial/<id> = default branch + `git merge --no-ff <branch>`, pushed to the same repo
//   2. light: the light-report runner checks trial/<id> → light <owner>--<repo>--trial-<id>
//   3. preview: a Railway service <repo>-trial-<id> in the same project, deployed from the trial tree, own domain
//   4. register the trial on the light-site router; flip the stable URL with `light-check flip`
// At most MAX_TRIALS trials per site: the oldest one that is not the current target is cleaned up first.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { MAX_TRIALS } from './router.mjs';

export const RAILWAY_GQL = 'https://backboard.railway.com/graphql/v2';
export const newTrialId = () => randomBytes(3).toString('hex');
export const trialBranch = (id) => `trial/${id}`;
export const trialLight = (repo, id) => `${repo.replace('/', '--')}--trial-${id}`;
export const trialService = (repo, id) => `${repo.split('/')[1].toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 40)}-trial-${id}`;
export const siteNameFor = (repo) => repo.split('/')[1].toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 63);

/** Which trials to remove so a new one fits: oldest first, never the current target. */
export function pickEvictions(site, max = MAX_TRIALS) {
  const trials = [...(site?.trials || [])].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  const out = [];
  let n = trials.length;
  for (const t of trials) { if (n < max) break; if (t.id === site.target) continue; out.push(t); n--; }
  return out;
}

const sh = (cmd, args, o = {}) => execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', maxBuffer: 64 << 20, ...o }).trim();

export function railway(token) {
  return async (query, variables = {}) => {
    const r = await fetch(RAILWAY_GQL, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query, variables }) });
    const j = await r.json();
    if (j.errors?.length) throw new Error(`railway: ${j.errors.map((e) => e.message).join('; ')}`);
    return j.data;
  };
}

export function siteClient(base, token) {
  base = base.replace(/\/+$/, '');
  const call = async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(j.error || `HTTP ${r.status}`), { status: r.status, body: j });
    return j;
  };
  return {
    get: (s) => call('GET', `/sites/${s}`).catch((e) => (e.status === 404 ? null : Promise.reject(e))),
    put: (s, live) => call('PUT', `/sites/${s}`, { live }),
    addTrial: (s, t) => call('POST', `/sites/${s}/trials`, t),
    delTrial: (s, id) => call('DELETE', `/sites/${s}/trials/${id}`),
    flip: (s, to, force) => call('POST', `/sites/${s}/flip`, { to, force: !!force }),
  };
}

async function waitUp(url, log, ms = 300000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(url, { redirect: 'manual' }); if (r.status < 500) return true; } catch {}
    await new Promise((r) => setTimeout(r, 5000));
  }
  log(`preview ${url} did not answer within ${ms / 1000}s`);
  return false;
}

/** Remove one trial everywhere: router entry, Railway service, branch. Best effort, logs what it did. */
export async function removeTrial({ repo, site, trial, sites, gql, log }) {
  try { await sites.delTrial(site, trial.id); log(`  router: removed trial ${trial.id}`); } catch (e) { log(`  router: ${e.message}`); }
  if (trial.service && gql) {
    try { await gql('mutation($id:String!){serviceDelete(id:$id)}', { id: trial.service }); log(`  railway: deleted service ${trial.service}`); } catch (e) { log(`  railway: ${e.message}`); }
  }
  try { sh('gh', ['api', '-X', 'DELETE', `repos/${repo}/git/refs/heads/${trialBranch(trial.id)}`]); log(`  github: deleted branch ${trialBranch(trial.id)}`); } catch (e) { log(`  github: branch not deleted (${String(e.stderr || e.message).trim().split('\n')[0]})`); }
}

/**
 * Run the whole trial. cfg: { repo, merge, site, lightBase, siteUrl, siteToken, railwayToken (workspace/API),
 * projectToken, projectId, environmentId, liveUrl, log }
 */
export async function runTrial(cfg) {
  const { repo, log } = cfg;
  const me = sh('gh', ['api', 'user', '-q', '.login']);
  const allowed = (process.env.LIGHT_TRIAL_OWNERS || me).split(',').map((s) => s.trim().toLowerCase());
  if (!allowed.includes(repo.split('/')[0].toLowerCase())) throw new Error(`v1 only trials repos owned by ${allowed.join(', ')} (got ${repo})`);
  const sites = siteClient(cfg.siteUrl, cfg.siteToken);
  const gql = railway(cfg.railwayToken);
  const site = cfg.site || siteNameFor(repo);

  // resolve --merge: a branch, or pr:N / #N for a same-repo pull request
  let branch = cfg.merge;
  const pr = /^(?:pr:|#)(\d+)$/.exec(branch);
  if (pr) {
    const j = JSON.parse(sh('gh', ['pr', 'view', pr[1], '--repo', repo, '--json', 'headRefName,isCrossRepository']));
    if (j.isCrossRepository) throw new Error('v1 merges same-repo PRs only (fork PRs need the GitHub App version)');
    branch = j.headRefName;
  }

  // site on the router: create with the live URL on first use
  let s = await sites.get(site);
  if (!s) { if (!cfg.liveUrl) throw new Error(`site ${site} not on the router yet; pass --live <url>`); s = await sites.put(site, cfg.liveUrl); log(`router: created site ${site} → live ${cfg.liveUrl}`); }

  // cap: make room
  for (const t of pickEvictions(s)) { log(`cleanup: trial ${t.id} (cap ${MAX_TRIALS})`); await removeTrial({ repo, site, trial: t, sites, gql, log }); }
  s = await sites.get(site);
  if (s.trials.length >= MAX_TRIALS) throw new Error(`site ${site} has ${s.trials.length} trials and the current target is one of them; flip to live first`);

  // 1. duplicate + merge
  const id = cfg.id || newTrialId();
  const tb = trialBranch(id);
  const dir = mkdtempSync(join(tmpdir(), 'lr-trial-'));
  try {
    log(`duplicate: ${repo} → branch ${tb}`);
    sh('gh', ['repo', 'clone', repo, dir, '--', '--quiet', '--no-tags']);
    const base = sh('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD']);
    sh('git', ['-C', dir, 'fetch', '--quiet', 'origin', `${branch}:refs/remotes/origin/${branch}`]);
    sh('git', ['-C', dir, 'checkout', '--quiet', '-b', tb]);
    try {
      sh('git', ['-C', dir, '-c', 'user.name=light-report trial', '-c', 'user.email=trial@light-report.invalid', 'merge', '--no-ff', '--no-edit', '-m', `trial ${id}: merge ${branch} into ${base}`, `origin/${branch}`]);
    } catch (e) { throw new Error(`merge of ${branch} into ${base} does not apply cleanly; nothing pushed`); }
    const sha = sh('git', ['-C', dir, 'rev-parse', 'HEAD']);
    sh('git', ['-C', dir, 'push', '--quiet', 'origin', tb]);
    log(`merge: ${branch} → ${base} as ${sha.slice(0, 7)} on ${tb}`);

    // 2. light
    const lb = cfg.lightBase.replace(/\/+$/, '');
    let r = await fetch(`${lb}/runs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ repo, ref: tb }) });
    let run = await r.json();
    if (!r.ok) throw new Error(`runner did not take the trial: ${run.error || r.status}`);
    log(`light: runner ${lb}/runs/${run.id}`);
    for (let i = 0; i < 900 && run.status !== 'done'; i++) { await new Promise((x) => setTimeout(x, 2000)); run = await (await fetch(`${lb}/runs/${run.id}`)).json(); }
    const light = run.status === 'done' ? run.light : 'dark';
    log(`light: ${light === 'lit' ? '● lit' : '○ dark'}  ${lb}/lights/${run.lightName || trialLight(repo, id)}`);

    // 3. preview service
    const name = trialService(repo, id);
    const svc = (await gql('mutation($i:ServiceCreateInput!){serviceCreate(input:$i){id name}}', { i: { projectId: cfg.projectId, name } })).serviceCreate;
    log(`preview: railway service ${name} (${svc.id})`);
    const dom = (await gql('mutation($i:ServiceDomainCreateInput!){serviceDomainCreate(input:$i){domain}}', { i: { serviceId: svc.id, environmentId: cfg.environmentId, targetPort: 8080 } })).serviceDomainCreate.domain;
    const url = `https://${dom}`;
    await gql('mutation($i:VariableCollectionUpsertInput!){variableCollectionUpsert(input:$i)}', { i: { projectId: cfg.projectId, environmentId: cfg.environmentId, serviceId: svc.id, variables: { PUBLIC_URL: url, LIGHT_TRIAL: id }, skipDeploys: true } });
    log(`preview: deploying ${tb} with railway up …`);
    execFileSync('railway', ['up', '--ci', '--service', svc.id, '--environment', cfg.environmentId], { cwd: dir, env: { ...process.env, RAILWAY_TOKEN: cfg.projectToken, RAILWAY_API_TOKEN: '' }, stdio: ['ignore', 'ignore', 'pipe'], maxBuffer: 64 << 20 });
    await waitUp(url, log);
    log(`preview: ${url}`);

    // 4. register
    await sites.addTrial(site, { id, url, light: run.lightName || trialLight(repo, id), branch: tb, service: svc.id });
    log(`router: site ${site} has trial ${id}; flip with: light-check flip ${site} ${id}`);
    return { id, branch: tb, sha, light, url, service: svc.id, site };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
