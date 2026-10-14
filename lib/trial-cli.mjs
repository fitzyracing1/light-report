// trial-cli.mjs — `light-check trial|flip|site`. Config comes from the environment; tokens are never printed.
//   LIGHT_SITE_URL            the light-site router (stable URL)       default https://light-site-production.up.railway.app
//   LIGHT_SITE_ADMIN_TOKEN    router admin token (flip, register)
//   LIGHT_REPORT_URL          runner                                    default https://light-report-production.up.railway.app
//   RAILWAY_API_TOKEN         workspace token: create/delete preview services and domains
//   RAILWAY_TOKEN             project token: `railway up` the trial tree
//   LIGHT_TRIAL_PROJECT_ID, LIGHT_TRIAL_ENVIRONMENT_ID   Railway project/environment for previews
import { runTrial, siteClient } from './trial.mjs';
import { REPO_RE } from './runner.mjs';

export const SITE_URL = 'https://light-site-production.up.railway.app';
const lamp = (l) => (l === 'lit' ? '● lit' : '○ dark');

export function parseTrialArgs(argv) {
  const o = { cmd: argv[0], pos: [], merge: null, site: null, live: null, force: false };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--merge') o.merge = argv[++i];
    else if (a === '--site') o.site = argv[++i];
    else if (a === '--live') o.live = argv[++i];
    else if (a === '--force') o.force = true;
    else if (a.startsWith('-')) throw new Error(`unknown argument ${a}`);
    else o.pos.push(a);
  }
  if (o.cmd === 'trial' && (o.pos.length !== 1 || !REPO_RE.test(o.pos[0]) || !o.merge)) throw new Error('usage: light-check trial owner/repo --merge <branch|pr:N> [--site name] [--live url]');
  if (o.cmd === 'flip' && o.pos.length !== 2) throw new Error('usage: light-check flip <site> <trial-id|live> [--force]');
  if (o.cmd === 'site' && o.pos.length !== 1) throw new Error('usage: light-check site <site>');
  return o;
}

export function describe(s) {
  const lines = [`site ${s.name}: stable URL → ${s.target} (${s.targetUrl})`, `  live    ${s.live}`];
  for (const t of s.trials) lines.push(`  ${t.id === s.target ? '▸' : ' '} ${t.id}  ${t.url}  light ${t.light}  ${t.branch}`);
  return lines.join('\n');
}

export async function trialCli(argv, env = process.env, out = console.log, err = console.error) {
  let o;
  try { o = parseTrialArgs(argv); } catch (e) { err(`light-check: ${e.message}`); return 2; }
  const siteUrl = env.LIGHT_SITE_URL || SITE_URL;
  const sites = siteClient(siteUrl, env.LIGHT_SITE_ADMIN_TOKEN);
  try {
    if (o.cmd === 'site') { const s = await sites.get(o.pos[0]); if (!s) { err(`no site ${o.pos[0]}`); return 2; } out(describe(s)); return 0; }
    if (o.cmd === 'flip') {
      if (!env.LIGHT_SITE_ADMIN_TOKEN) { err('light-check: set LIGHT_SITE_ADMIN_TOKEN'); return 2; }
      try {
        const s = await sites.flip(o.pos[0], o.pos[1], o.force);
        out(`flipped: ${siteUrl} → ${s.target} (${s.targetUrl})`); return 0;
      } catch (e) { err(`light-check: ${e.message}`); return e.status === 409 ? 1 : 2; }
    }
    for (const k of ['LIGHT_SITE_ADMIN_TOKEN', 'RAILWAY_API_TOKEN', 'RAILWAY_TOKEN', 'LIGHT_TRIAL_PROJECT_ID', 'LIGHT_TRIAL_ENVIRONMENT_ID']) if (!env[k]) { err(`light-check: set ${k}`); return 2; }
    const r = await runTrial({
      repo: o.pos[0], merge: o.merge, site: o.site, liveUrl: o.live, siteUrl, siteToken: env.LIGHT_SITE_ADMIN_TOKEN,
      lightBase: env.LIGHT_REPORT_URL || 'https://light-report-production.up.railway.app', railwayToken: env.RAILWAY_API_TOKEN,
      projectToken: env.RAILWAY_TOKEN, projectId: env.LIGHT_TRIAL_PROJECT_ID, environmentId: env.LIGHT_TRIAL_ENVIRONMENT_ID, log: (m) => err(m),
    });
    out(`${lamp(r.light)}  trial ${r.id}  ${r.branch}  preview ${r.url}\nnext: light-check flip ${r.site} ${r.id}${r.light === 'lit' ? '' : ' --force   (dark: refused without --force)'}`);
    return r.light === 'lit' ? 0 : 1;
  } catch (e) { err(`light-check: ${e.message}`); return 2; }
}
