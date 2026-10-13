// github.mjs — optional adapter: GitHub is just one more source.
// Same rule as fitzyracing1/lit-dark read-light.mjs: newest completed push run,
// conclusion === "success" → lit, anything else → dark. No run / HTTP error is an error, not a light.
export async function readGitHubLight(repo, { token = process.env.GITHUB_TOKEN, fetchImpl = fetch } = {}) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`bad repo: ${repo}`);
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'light-report', 'X-GitHub-Api-Version': '2022-11-28' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetchImpl(`https://api.github.com/repos/${repo}/actions/runs?per_page=1&status=completed&event=push`, { headers });
  if (!res.ok) throw new Error(`${repo}: HTTP ${res.status}`);
  const run = (await res.json()).workflow_runs?.[0];
  if (!run) throw new Error(`${repo}: no completed push workflow runs yet`);
  return { state: run.conclusion === 'success' ? 'lit' : 'dark', source: 'github', detail: `${run.name} ${run.html_url}` };
}
