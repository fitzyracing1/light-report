// darks.mjs — pure logic for the dark crawler: strict lit/dark per workflow, cause classes, state merge.
// Rule: per workflow that still exists on the default branch, the latest completed push/schedule run on the
// default branch within 30 days. success → lit, anything else → dark. Newest run wins.

// The relevant-run rules live in @fitzyracing1/light-core (shared with every light reader).
// Re-runs: the latest attempt wins and runs are ordered by run_started_at.
export { DAY_MS, IGNORED_NAME, isIgnoredWorkflow, lightsForRepo } from '@fitzyracing1/light-core';
import { DAY_MS } from '@fitzyracing1/light-core';

/** @deprecated use DAY_MS */
export const DAY = DAY_MS;

const GENERIC = /^(Process completed with exit code \d+\.?|The job was not started because.*|Node\.js \d+ actions are deprecated.*|.*is deprecated.*|The `set-output` command is deprecated.*)$/i;
/** Pick a one-line cause from check-run annotations (and the failed step name as fallback). */
export function pickCause({ annotations = [], failedJob = null, failedStep = null, conclusion }) {
  const fails = annotations.filter((a) => a.annotation_level === 'failure');
  const specific = fails.find((a) => !GENERIC.test(String(a.message || '').trim().split('\n')[0]));
  const oneLine = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '').split('\n').map((x) => x.trim()).find(Boolean)?.slice(0, 240) || '';
  if (specific) return oneLine(specific.message) + (specific.path && specific.path !== '.github' ? ` (${specific.path}${specific.start_line ? ':' + specific.start_line : ''})` : '');
  if (conclusion && conclusion !== 'failure') return `run ${conclusion}${failedJob ? ` in job "${failedJob}"` : ''}`;
  if (failedStep) return `step "${failedStep}"${failedJob ? ` in job "${failedJob}"` : ''} exited nonzero` + (fails[0] && !GENERIC.test(oneLine(fails[0].message)) ? ` — ${oneLine(fails[0].message)}` : '');
  if (fails[0]) return oneLine(fails[0].message);
  return 'no cause found in annotations';
}

/** Classify: infra / external / flaky / code bug. */
export function classify({ cause = '', conclusion, streak = 1, prevLit = false }) {
  const c = cause.toLowerCase();
  if (['cancelled', 'timed_out', 'startup_failure', 'skipped', 'action_required', 'stale', 'neutral'].includes(conclusion) ||
    /no space left|runner .*(lost|shutdown|offline)|lost communication|the operation was canceled|exit code 143|out of memory|oom|killed|hosted runner|disk quota|job was not started|exceeded the maximum execution time/.test(c)) return 'infra';
  if (/could not resolve host|enotfound|econnreset|etimedout|eai_again|registry|npm err! 404|e404|429|rate limit|503|502|service unavailable|certificate|tls|bad credentials|secret|token|unauthorized|forbidden|403|401|quota|api key|deprecated|no longer supported|download|unable to access|repository not found|docker hub|toomanyrequests/.test(c)) return 'external';
  if (/flaky|intermittent|timeout of \d+ms exceeded|timed out in \d+|timed out after|deadline exceeded|race|socket hang up/.test(c) || (prevLit && streak === 1 && /timeout|timed out/.test(c))) return 'flaky';
  return 'code bug';
}

export const keyOf = (repo, path) => `${repo}#${path}`;
export const STATUSES = ['new', 'fix-trying', 'fix-lit', 'PR-queued', 'relit'];

/**
 * Merge a fresh scan into the previous state.
 * prev: { darks: {key: entry} }, scanned: Map repo → { stars, lights:[...with cause/class] }, overrides: {key: status}, queued: [{key,...}]
 */
export function mergeState(prev, scanned, { overrides = {}, queued = [], now = Date.now(), keepRelitDays = 14 } = {}) {
  const darks = { ...(prev?.darks || {}) };
  const qkeys = new Set(queued.map((q) => q.key));
  for (const [repo, info] of scanned) {
    const seen = new Set();
    for (const l of info.lights) {
      const key = keyOf(repo, l.path);
      seen.add(key);
      const old = darks[key];
      if (l.light === 'dark') {
        const fresh = !old || old.status === 'relit';
        darks[key] = {
          key, repo, stars: info.stars, workflow: l.workflow, path: l.path, light: 'dark',
          darkSince: fresh ? l.darkSince : (old.darkSince || l.darkSince),
          cause: l.cause, class: l.class, run: l.run.url, runAt: l.run.startedAt, conclusion: l.conclusion,
          status: fresh ? 'new' : old.status, firstSeen: fresh ? new Date(now).toISOString() : old.firstSeen,
          lastChecked: new Date(now).toISOString(), issue: old?.issue ?? null,
        };
      } else if (old && old.light === 'dark') {
        darks[key] = { ...old, light: 'lit', status: 'relit', relitAt: l.run.startedAt, relitRun: l.run.url, lastChecked: new Date(now).toISOString() };
      }
    }
    // workflow gone or no qualifying run in 30 days: it no longer has a dark light under the rule
    for (const [key, e] of Object.entries(darks)) {
      if (e.repo === repo && !seen.has(key) && e.light === 'dark') darks[key] = { ...e, light: 'lit', status: 'relit', relitAt: new Date(now).toISOString(), relitRun: null, relitNote: 'no qualifying run in the last 30 days, or the workflow is gone', lastChecked: new Date(now).toISOString() };
    }
  }
  for (const [key, e] of Object.entries(darks)) {
    if (e.light === 'dark') {
      if (overrides[key] && overrides[key] !== 'relit') e.status = overrides[key];
      else if (qkeys.has(key) && (e.status === 'new' || e.status === 'fix-trying' || e.status === 'fix-lit')) e.status = 'PR-queued';
    }
    if (e.status === 'relit' && e.relitAt && now - Date.parse(e.relitAt) > keepRelitDays * DAY_MS && (!e.issue || e.issueClosed)) delete darks[key];
  }
  return { ...prev, darks, updatedAt: new Date(now).toISOString() };
}

export function issueTitle(e) { return `${e.light === 'dark' ? '○ dark' : '● relit'}: ${e.repo} — ${e.workflow}`; }
export function issueBody(e) {
  const et = (t) => (t ? new Date(t).toLocaleString('en-US', { timeZone: 'America/New_York', dateStyle: 'medium', timeStyle: 'short' }) + ' ET' : '—');
  return `<!-- dark-key: ${e.key} -->
| | |
|---|---|
| repo | [${e.repo}](https://github.com/${e.repo}) (${e.stars ?? '?'} ★) |
| workflow | \`${e.path}\` (${e.workflow}) |
| light | ${e.light === 'dark' ? '○ dark' : '● lit (relit)'} |
| dark since | ${et(e.darkSince)} |
| cause | ${String(e.cause || '').replace(/\|/g, '\\|')} |
| class | ${e.class} |
| run | ${e.run} |
| status | ${e.status} |
${e.relitAt ? `| relit | ${et(e.relitAt)}${e.relitRun ? ` — ${e.relitRun}` : ''} |\n` : ''}
Found by the [dark crawler](https://github.com/fitzyracing1/darks) with the strict rule: latest completed push/schedule run on the default branch within 30 days, per workflow; success = lit, anything else = dark.

_This issue lives only in fitzyracing1/darks. Nothing is posted to ${e.repo}; any upstream action waits in the approval queue._`;
}
export const labelsFor = (e) => ['dark', `class: ${e.class}`, `status: ${e.status}`];
