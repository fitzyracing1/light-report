// site.mjs — the landing/guide page served at GET /. No external assets.
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const code = (s) => `<div class="code"><button class="copy" type="button" aria-label="Copy">Copy</button><pre><code>${esc(s.trim())}</code></pre></div>`;

export function siteHtml({ base = 'https://light-report-production.up.railway.app', ttlSeconds = 86400, lights = [] } = {}) {
  const B = base;
  const npx = 'npx -y -p github:fitzyracing1/light-report';
  const litCount = lights.filter((l) => l.light === 'lit').length;
  const boardRows = lights.slice(0, 12).map((v) => `<tr class="${v.light}"><td class="lamp">${v.light === 'lit' ? '●' : '○'}</td><td><a href="/lights/${esc(v.name)}">${esc(v.name)}</a></td><td>${v.light}</td><td>${v.bit}</td><td>${esc(v.source ?? '')}</td></tr>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>light-report — one lit/dark light for any build, test or check</title>
<meta name="description" content="Report a lit/dark CI light from anywhere, or let light-report run a public repo's tests. lit = 0, dark = 1.">
<style>
:root{--bg:#0f1115;--panel:#171a21;--line:#2a2f3a;--text:#e7e9ee;--mute:#9aa3b2;--lit:#f2b705;--dark:#5b6270;--link:#8ab4ff}
*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:var(--bg);color:var(--text);font:16px/1.6 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
a{color:var(--link)}main{max-width:920px;margin:0 auto;padding:0 20px 80px}
nav{position:sticky;top:0;background:rgba(15,17,21,.93);backdrop-filter:blur(6px);border-bottom:1px solid var(--line);z-index:5}
nav div{max-width:920px;margin:0 auto;padding:10px 20px;display:flex;gap:16px;overflow-x:auto;white-space:nowrap;font-size:14px}
nav a{color:var(--mute);text-decoration:none}nav a:hover{color:var(--text)}nav b{color:var(--lit)}
header{padding:56px 0 24px}h1{font-size:clamp(30px,6vw,46px);line-height:1.15;margin:0 0 12px}h1 .l{color:var(--lit)}h1 .d{color:var(--dark)}
.lead{font-size:19px;color:var(--mute);max-width:700px}h2{margin:56px 0 12px;font-size:26px;border-top:1px solid var(--line);padding-top:32px}h3{margin:28px 0 8px;font-size:18px}
.code{position:relative;margin:10px 0 16px}pre{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:14px 16px;overflow-x:auto;margin:0;font:13.5px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.92em}p code,li code,td code{background:var(--panel);padding:1px 5px;border-radius:4px}
.copy{position:absolute;top:8px;right:8px;background:#232834;color:var(--mute);border:1px solid var(--line);border-radius:6px;padding:3px 10px;font-size:12px;cursor:pointer}.copy:hover{color:var(--text)}
table{width:100%;border-collapse:collapse;margin:10px 0;font-size:14.5px}th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--mute);font-weight:600}
.wrap{overflow-x:auto}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px;margin:16px 0}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:18px}.card h3{margin-top:0}
.lamp{font-size:20px}.lit .lamp,.lit-t{color:var(--lit)}.dark .lamp,.dark-t{color:var(--dark)}
.big{display:flex;gap:28px;align-items:center;margin:18px 0;flex-wrap:wrap}.big div{font-size:15px}.big span{font-size:42px;line-height:1;margin-right:10px;vertical-align:middle}
.note{border-left:3px solid var(--lit);padding:4px 14px;color:var(--mute);margin:14px 0}ol li,ul li{margin:4px 0}details{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:10px 16px;margin:10px 0}summary{cursor:pointer;font-weight:600}
footer{color:var(--mute);font-size:14px;border-top:1px solid var(--line);margin-top:56px;padding-top:20px}
</style></head><body>
<nav><div><b>● light-report</b><a href="#lights">lit &amp; dark</a><a href="#ways">two ways</a><a href="#quickstart">quickstart</a><a href="#report">report</a><a href="#run">run</a><a href="#agents">AI agents</a><a href="#light-file">light.yml</a><a href="#badge">badge</a><a href="#api">API</a><a href="#detect">detection</a><a href="#limits">limits</a><a href="#faq">FAQ</a><a href="/board">board</a><a href="https://github.com/fitzyracing1/light-report">GitHub</a></div></nav>
<main>
<header><h1>One <span class="l">lit</span> / <span class="d">dark</span> light for any build, test or check.</h1>
<p class="lead">Report the result of anything that has an exit code — a shell script, a cron job, Jenkins, GitLab, a health check — or let light-report run a public repo's tests for you. Read it back as JSON, a one-word file, or a README badge.</p>
${code(`${npx} light-check fitzyracing1/light-report`)}
<p>Live board: <a href="/board">${lights.length} light${lights.length === 1 ? '' : 's'}, ${litCount} lit</a> · <a href="https://github.com/fitzyracing1/light-report">source on GitHub</a> (MIT)</p></header>

<section id="lights"><h2>What lit and dark mean</h2>
<p>A light is <b>one bit</b>. It is <b>active-low</b>, like a hardware signal line: the "everything is fine" state is the zero.</p>
<div class="big"><div><span class="lit-t">●</span><b>lit</b> = <code>0</code><br>exit code 0, or <code>state: "lit"</code>, or GitHub conclusion <code>success</code></div>
<div><span class="dark-t">○</span><b>dark</b> = <code>1</code><br>anything else: nonzero exit, cancelled, timeout, or no report in time</div></div>
<ul><li><b>Exit code 0 is lit. Any other exit code is dark.</b> There is no third state.</li>
<li><b>Stale is dark.</b> If a light gets no report for ${Math.round(ttlSeconds / 3600)} hours (<code>LIGHT_TTL_SECONDS</code>), it reads dark with <code>"stale": true</code>. A name nobody ever reported is dark and stale.</li>
<li>GitHub's words are mapped once at the edge (<code>success</code> → lit, anything else → dark). After that, only lit and dark.</li>
<li>Eight lights pack into one active-low byte, MSB first: <code>●●●●○○●●</code> → <code>00001100</code> → <code>12</code>.</li></ul>
<p>The full rule lives in the <a href="https://github.com/fitzyracing1/lit-dark/blob/main/SPEC.md">lit-dark spec</a> (<a href="https://github.com/fitzyracing1/lit-dark">fitzyracing1/lit-dark</a>).</p></section>

<section id="ways"><h2>Two ways to use it</h2><div class="grid">
<div class="card"><h3>1. Report from anywhere</h3><p>Your build runs wherever it already runs. Wrap the command with <code>light-run</code>, or send one <code>curl</code> with the exit code. light-report keeps the light.</p><p><a href="#report">How to report →</a></p></div>
<div class="card"><h3>2. Let the server run your repo</h3><p>Point <code>light-check</code> at a public GitHub repo. light-report clones it, runs its tests, streams the log, and turns the exit code into a light.</p><p><a href="#run">How to run →</a></p></div></div></section>

<section id="quickstart"><h2>30-second quickstart</h2>
<p>You need Node 18 or newer. Nothing to install: <code>npx</code> fetches the CLI from GitHub.</p>
<h3>Check a repo (server runs its tests)</h3>${code(`${npx} light-check owner/repo`)}
<p>You see <code>◌ running…</code>, the live log, then <code>● lit</code> or <code>○ dark</code>. Exit code: 0 for lit, 1 for dark, 2 if the run could not start (that is not a light).</p>
<h3>Read a repo's GitHub light instead</h3>${code(`${npx} light-check owner/repo --github`)}
<p>Reads the newest completed push run on GitHub Actions and maps it once: <code>success</code> → lit, anything else → dark.</p>
<h3>Report your own command</h3>${code(`${npx} light-run my-backup -- ./backup.sh`)}
<p>The first report for a new name prints a <b>write token once</b>. Save it (<code>export LIGHT_TOKEN_MY_BACKUP=lr_…</code>); later reports for that name need it.</p></section>

<section id="report"><h2>Report from anywhere</h2>
<p><code>light-run &lt;name&gt; -- &lt;command&gt;</code> runs your command, reports its exit code, and exits with the <b>same</b> code, so your script or CI step behaves exactly as before.</p>
<table><tr><th>env</th><th>meaning</th></tr>
<tr><td><code>LIGHT_REPORT_URL</code></td><td>server (default <code>${esc(B)}</code>)</td></tr>
<tr><td><code>LIGHT_TOKEN_&lt;NAME&gt;</code> or <code>LIGHT_TOKEN</code></td><td>write token for the light (name upper-cased, other characters become <code>_</code>)</td></tr>
<tr><td><code>LIGHT_SOURCE</code></td><td>label shown on the board (default <code>light-run@&lt;hostname&gt;</code>)</td></tr></table>
<h3>Shell</h3>${code(`export LIGHT_TOKEN_DEPLOY=lr_...
${npx} light-run deploy -- ./deploy.sh`)}
<h3>curl (anything with an exit code)</h3>${code(`./deploy.sh; curl -fsS -X POST ${B}/lights/deploy \\
  -H "Authorization: Bearer $LIGHT_TOKEN" -H 'Content-Type: application/json' \\
  -d "{\\"exitCode\\": $?, \\"source\\": \\"shell\\"}"`)}
<h3>cron</h3>${code(`0 3 * * * /opt/backup.sh; curl -fsS -X POST ${B}/lights/backup -H "Authorization: Bearer lr_..." -H 'Content-Type: application/json' -d "{\\"exitCode\\": $?, \\"source\\": \\"cron\\"}"`)}
<h3>Jenkins (declarative pipeline)</h3>${code(`post {
  success      { sh 'curl -fsS -X POST $LIGHT_REPORT_URL/lights/$JOB_NAME -H "Authorization: Bearer $LIGHT_TOKEN" -H "Content-Type: application/json" -d \\'{"state":"lit","source":"jenkins"}\\'' }
  unsuccessful { sh 'curl -fsS -X POST $LIGHT_REPORT_URL/lights/$JOB_NAME -H "Authorization: Bearer $LIGHT_TOKEN" -H "Content-Type: application/json" -d \\'{"state":"dark","source":"jenkins"}\\'' }
}`)}
<h3>GitLab CI</h3>${code(`test:
  script:
    - ${npx} light-run $CI_PROJECT_NAME -- npm test
  variables:
    LIGHT_REPORT_URL: ${B}   # put LIGHT_TOKEN in masked CI/CD variables`)}
<h3>Health check (every 5 minutes)</h3>${code(`*/5 * * * * curl -fsS https://example.com/health >/dev/null; curl -fsS -X POST ${B}/lights/example-health -H "Authorization: Bearer lr_..." -H 'Content-Type: application/json' -d "{\\"exitCode\\": $?, \\"source\\": \\"healthcheck\\"}"`)}
<p class="note">If the checker itself stops, the light goes dark on its own once it is stale. That is the point of the TTL.</p>
<h3>Read a light back</h3>${code(`curl -s ${B}/lights/deploy          # JSON
curl -s ${B}/lights/deploy/LIGHT    # one word: lit or dark
[ "$(curl -s ${B}/lights/deploy/LIGHT)" = lit ] && echo "go ahead"`)}
</section>

<section id="run"><h2>Let the server run your repo</h2>
<ol><li>Make sure the repo is <b>public</b> on GitHub and its tests can run from a clean clone.</li>
<li>Optional: add a <a href="#agents">AI agents</a><a href="#light-file">light.yml</a> to say exactly what to run. Otherwise the runner <a href="#detect">detects it</a>.</li>
<li>Run <code>light-check</code>:</li></ol>
${code(`${npx} light-check owner/repo
${npx} light-check owner/repo --ref v1.2.0
${npx} light-check owner/repo --cmd 'npm ci && npm run lint && npm test'`)}
<p>The result is saved as a light named <code>owner--repo</code> (the slash becomes two dashes), source <code>light-report-runner</code>, so it shows on the <a href="/board">board</a> and as a badge.</p>
<h3>Same thing with curl</h3>${code(`curl -s -X POST ${B}/runs -H 'Content-Type: application/json' \\
  -d '{"repo":"owner/repo","ref":"main","command":"npm test"}'
# {"id":"9f2c...","status":"queued","log":"/runs/9f2c.../log",...}
curl -N ${B}/runs/9f2c.../log    # live log until the run ends
curl -s ${B}/runs/9f2c...        # {"status":"done","light":"lit","bit":0,"exitCode":0,...}`)}
</section>

<section id="agents"><h2>For AI agents (Claude Code, VS Code / Copilot, Cursor)</h2>
<p>Make your coding agent run the light by itself, in the terminal, before anything goes to GitHub — and keep fixing while it is dark. One command sets it up:</p>
${code(`cd your-repo
${npx} light-check init              # Claude Code + VS Code + Cursor + AGENTS.md
${npx} light-check init --pre-push   # also block git push while dark`)}
<p>It only adds to your files: JSON settings are merged, markdown gets one marked block (<code>&lt;!-- light-check:start --&gt;</code>), and running it again changes nothing. A JSON file with comments is left alone and listed as skipped. Commit what it writes.</p>
<h3>Check a local folder</h3>
${code(`${npx} light-check . --local     # run the tests here, nothing uploaded, report the light
${npx} light-check .             # upload the working tree and run it on the server
${npx} light-check ../app --name my-app --cmd 'npm test'`)}
<ul><li><code>--local</code> runs the detected command (same <a href="#detect">detection</a> and <a href="#light-file">light.yml</a>) on your machine and reports the light <code>local--&lt;folder&gt;</code>. Add <code>--no-report</code> to keep it entirely offline.</li>
<li>Without <code>--local</code>, the folder is packed and sent to <code>POST /runs/upload</code>. It respects <code>.gitignore</code> and <b>always leaves out</b> <code>.git</code>, <code>node_modules</code>, <code>.env*</code>, <code>*.pem</code>, <code>*.key</code>, SSH keys, <code>.npmrc</code>, <code>.netrc</code> and similar. Over 20 MB total is refused. Same runner limits as repo runs.</li>
<li>Write tokens are saved in <code>~/.config/light-report/tokens.json</code>, so repeat reports just work.</li></ul>
<h3>Claude Code</h3>
<ol><li>Run <code>light-check init</code>. It adds a <b>Stop hook</b> to <code>.claude/settings.json</code> and a note to <code>CLAUDE.md</code>:</li></ol>
${code(`{
  "hooks": {
    "Stop": [
      { "hooks": [ { "type": "command",
        "command": "${npx} light-check --hook claude-stop",
        "timeout": 900 } ] }
    ]
  }
}`)}
<ol start="2"><li>When Claude finishes a turn, the hook runs the tests locally. <b>Lit</b>: Claude stops as usual. <b>Dark</b>: the hook answers <code>{"decision":"block","reason":"…last log lines…"}</code>, which tells Claude Code not to stop, and Claude goes back to fixing with the log in front of it.</li>
<li>To avoid an endless loop it lets Claude stop after 8 dark rounds in one session, with a note for you.</li>
<li>Optional: <code>light-check init --post-edit</code> also adds a <code>PostToolUse</code> hook on <code>Edit|Write|MultiEdit</code> that shows Claude the dark log right after an edit (it can't undo the edit). It runs the tests on every edit, so use it only for fast test suites.</li>
<li>Check it with <code>/hooks</code> inside Claude Code.</li></ol>
<h3>VS Code (Copilot agent mode)</h3>
<ol><li><code>light-check init</code> adds a <b>light-check</b> task to <code>.vscode/tasks.json</code> (Terminal → Run Task → light-check; <code>--folder-open</code> runs it whenever the folder opens) and a block in <code>.github/copilot-instructions.md</code> telling Copilot to run <code>light-check . --local</code> before it says it is done, and to keep fixing until it is lit.</li>
<li>Copilot agent mode reads <code>.github/copilot-instructions.md</code> (and <code>AGENTS.md</code>) on its own. Allow it to run terminal commands so it can call the check.</li></ol>
<h3>Cursor</h3>
<ol><li><code>light-check init</code> writes <code>.cursor/rules/light-check.mdc</code> (<code>alwaysApply: true</code>) and a block in <code>AGENTS.md</code> with the same instruction.</li>
<li>Cursor's agent picks up the rule in every chat; let it run terminal commands.</li></ol>
<h3>git pre-push hook (any editor, any agent)</h3>
${code(`${npx} light-check init --pre-push
git push                 # runs light-check . --local first; dark → push blocked
git push --no-verify     # skip it once`)}
<p class="note">Instruction files (Copilot, Cursor, AGENTS.md) ask the agent to run the check; the agent can still ignore them. The Claude Code Stop hook and the git pre-push hook actually enforce it.</p>
</section>

<section id="light-file"><h2>Add a light.yml</h2>
<p>Put <code>light.yml</code> (or <code>light.yaml</code> or <code>.light</code>) in the repo root. One shell command per <code>run:</code> line, run in order from the repo root. The first command that exits nonzero stops the run and the light is dark. <code>#</code> starts a comment; other lines are ignored.</p>
${code(`# light.yml
run: npm ci
run: npm run lint
run: npm test`)}
</section>

<section id="badge"><h2>Add a badge to your README</h2>
${code(`![light](${B}/lights/NAME/badge.svg)`)}
<p>For a repo checked by the runner, <code>NAME</code> is <code>owner--repo</code>:</p>
${code(`[![light](${B}/lights/owner--repo/badge.svg)](${B}/lights/owner--repo)`)}
<p>Example: <img alt="light-report light" src="/lights/fitzyracing1--light-report/badge.svg" style="vertical-align:middle"> <img alt="demo light" src="/lights/fitzyracing1--light-demo-dark/badge.svg" style="vertical-align:middle"></p></section>

<section id="api"><h2>API reference</h2><div class="wrap"><table>
<tr><th>method &amp; path</th><th>body / auth</th><th>gives</th></tr>
<tr><td><code>POST /lights/:name</code></td><td><code>{"exitCode":0}</code> or <code>{"state":"lit"|"dark"}</code>, <code>source</code>, optional <code>detail</code>. <code>Authorization: Bearer &lt;token&gt;</code> after the first report.</td><td>201 + one-time <code>token</code> on first report, 200 after, 401 on wrong token</td></tr>
<tr><td><code>POST /lights/:name/github</code></td><td><code>{"repo":"owner/repo"}</code>, same token rule</td><td>light from the newest completed push run (502 if GitHub can't be read)</td></tr>
<tr><td><code>GET /lights/:name</code></td><td>—</td><td><code>{name, light, bit, source, detail, reportedAt, stale}</code></td></tr>
<tr><td><code>GET /lights/:name/LIGHT</code></td><td>—</td><td>plain text <code>lit</code> or <code>dark</code></td></tr>
<tr><td><code>GET /lights/:name/badge.svg</code></td><td>—</td><td>SVG badge</td></tr>
<tr><td><code>GET /lights</code></td><td>—</td><td>all lights as JSON</td></tr>
<tr><td><code>POST /runs</code></td><td><code>{"repo":"owner/repo","ref"?,"command"?}</code>, no auth, rate limited</td><td>202 <code>{id, status:"queued", log, …}</code>; 429 over the limit; 503 queue full</td></tr>
<tr><td><code>POST /runs/upload</code></td><td>gzip'd JSON <code>{"name","command"?,"files":[{"path","mode","data":base64}]}</code>; up to 20 MB of files; same rate limit</td><td>202 <code>{id, status, lightName, …}</code>; the light is <code>name</code></td></tr>
<tr><td><code>GET /runs/:id</code></td><td>—</td><td><code>{status, light, bit, exitCode, command, detected, timedOut, error, queuedAt, startedAt, finishedAt, seconds, lightName}</code></td></tr>
<tr><td><code>GET /runs/:id/log</code></td><td>—</td><td>chunked plain text, streamed live until the run ends</td></tr>
<tr><td><code>GET /runs</code></td><td>—</td><td>recent runs (newest first)</td></tr>
<tr><td><code>GET /board</code></td><td>—</td><td>HTML board of all lights</td></tr>
<tr><td><code>GET /health</code></td><td>—</td><td><code>{ok, persistent, ttlSeconds}</code></td></tr>
</table></div>
<p>Light names: letters, digits, <code>.</code> <code>_</code> <code>-</code>, up to 100 characters. Tokens are stored only as SHA-256 hashes.</p></section>

<section id="detect"><h2>What the runner runs</h2>
<p>If you don't give a <code>command</code>, the runner takes the first match:</p><ol>
<li><b>light.yml / light.yaml / .light</b> — your <code>run:</code> lines.</li>
<li><b>package.json</b> with a <code>test</code> script — <code>npm ci</code> (lockfile) or <code>npm install</code>, then <code>npm test</code>.</li>
<li><b>Cargo.toml</b> — <code>cargo test</code>, only if a Rust toolchain is installed. The hosted runner has none, so these read dark with the reason in the log.</li>
<li><b>pyproject.toml / setup.py / requirements.txt</b> — fresh venv, <code>pip install</code> requirements and the project, then <code>pytest</code>.</li>
<li><b>Makefile</b> with a <code>test:</code> target — <code>make test</code>.</li></ol>
<p>Nothing found → dark, and the log says why. Toolchains on the hosted runner: Node 22 + npm, Python 3, git, make.</p></section>

<section id="limits"><h2>Limits and safety — honestly</h2>
<p class="note">The runner is a convenience, <b>not a full sandbox</b>. Only point it at code you would be fine running on a small shared box.</p><ul>
<li><b>Public GitHub repos only</b> for repo runs. Clones are anonymous; private repos don't clone. Folder uploads (<code>light-check .</code>) send your files to this server — use <code>--local</code> for private code. Refs must be branches or tags (shallow clone), not commit SHAs.</li>
<li>Each job runs as an <b>unprivileged user</b> in a fresh temp directory that is <b>wiped</b> afterwards, with an environment built from scratch: no server variables, Railway settings or tokens reach it, and it can't read the light store.</li>
<li>Jobs <b>share the container's kernel, network, CPU and memory</b>. There is no network isolation and no per-job memory limit.</li>
<li><b>10-minute hard cap</b> per job; the whole process group is killed and the light is dark.</li>
<li><b>One job at a time</b>, up to 10 waiting. <b>6 runs per hour per IP.</b></li>
<li>Logs are capped at 1 MB and kept <b>in memory only</b> for the last 100 runs; a restart forgets them. Lights are persisted.</li>
<li><b>Anyone can run any public repo</b>, which writes the <code>owner--repo</code> light. Running with a custom <code>--cmd</code> also writes it. Use other names for lights you report yourself.</li></ul></section>

<section id="faq"><h2>FAQ</h2>
<details><summary>Is this replacing GitHub Actions?</summary><p>No. light-report is a small runner plus a scoreboard. GitHub Actions is one optional source of lights (<code>light-check --github</code>, <code>POST /lights/:name/github</code>). Use it next to whatever CI you already have — or for the jobs that have no CI at all, like cron scripts and health checks.</p></details>
<details><summary>Does my code leave my machine with the AI-agent setup?</summary><p>No. The hooks and instructions use <code>light-check . --local</code>: tests run on your machine and only the light (lit/dark, exit code, command) is reported. Add <code>--no-report</code> to send nothing at all.</p></details>
<details><summary>Why is lit 0 and dark 1?</summary><p>Because exit code 0 means "it worked" everywhere in Unix, and the lit-dark spec keeps that: active-low, lit = 0, dark = 1. A missing signal reads as 1 — dark — which is the safe default.</p></details>
<details><summary>Why is my light dark when nothing ran?</summary><p>No report within the TTL means stale, and stale means dark. Report again, or raise <code>LIGHT_TTL_SECONDS</code> on your own server.</p></details>
<details><summary>I lost my write token.</summary><p>Tokens are shown once and stored hashed, so they can't be recovered. Use a new light name.</p></details>
<details><summary>Can I run my own server?</summary><p>Yes. <code>node server.mjs</code> with Node 18+, no dependencies. Set <code>DATA_DIR</code> to persist lights. The repo has a Dockerfile; this instance runs on Railway with a volume at <code>/data</code>.</p></details>
<details><summary>Does a GitHub API error make a light dark?</summary><p>No. Per the spec, "could not read GitHub" is an error (HTTP 502 / exit 2), not a dark light.</p></details>
</section>

<section><h2>Live board</h2>
${lights.length ? `<div class="wrap"><table><tr><th></th><th>name</th><th>light</th><th>bit</th><th>source</th></tr>${boardRows}</table></div>` : '<p>No lights yet.</p>'}
<p><a href="/board">Full board →</a> · <a href="/lights">JSON</a> · <a href="/runs">recent runs</a></p></section>

<footer>light-report · MIT © 2026 Joshua Almeida · <a href="https://github.com/fitzyracing1/light-report">github.com/fitzyracing1/light-report</a> · rule: <a href="https://github.com/fitzyracing1/lit-dark">fitzyracing1/lit-dark</a></footer>
</main>
<script>document.addEventListener('click',e=>{const b=e.target.closest('.copy');if(!b)return;const t=b.parentElement.querySelector('code').innerText;(navigator.clipboard?navigator.clipboard.writeText(t):Promise.reject()).then(()=>{b.textContent='Copied';setTimeout(()=>b.textContent='Copy',1200)}).catch(()=>{const r=document.createRange();r.selectNodeContents(b.parentElement.querySelector('code'));getSelection().removeAllRanges();getSelection().addRange(r)})})</script>
</body></html>`;
}
