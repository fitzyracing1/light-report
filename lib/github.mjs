// github.mjs — optional adapter: GitHub is just one more source.
// Same rule as fitzyracing1/lit-dark read-light.mjs, via @fitzyracing1/light-core: newest completed push run,
// conclusion === "success" → lit, anything else → dark. No run / HTTP error is an error, not a light.
// Rate limits (403/429 retry-after, x-ratelimit-reset) are waited out or refused by the light-core client.
import { createGitHub, readLatestPushLight } from '@fitzyracing1/light-core';

export async function readGitHubLight(repo, { token = process.env.GITHUB_TOKEN, fetchImpl = fetch, sleep } = {}) {
  const gh = createGitHub({ token, fetch: (...a) => fetchImpl(...a), userAgent: 'light-report', ...(sleep ? { sleep } : {}) });
  const r = await readLatestPushLight(gh, repo);
  return { state: r.light, source: 'github', detail: `${r.workflow} ${r.url}` };
}
