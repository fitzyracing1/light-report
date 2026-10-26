# ● light-report

**One lit / dark light for any build, test or check.** Report the exit code of anything — a shell script, cron, Jenkins, GitLab, a health check — or let light-report run a public repo's tests for you. Read it back as JSON, a one-word file, or a badge.

[![light-report light](https://light-report-production.up.railway.app/lights/fitzyracing1--light-report/badge.svg)](https://light-report-production.up.railway.app/lights/fitzyracing1--light-report)
[![ci](https://github.com/fitzyracing1/light-report/actions/workflows/ci.yml/badge.svg)](https://github.com/fitzyracing1/light-report/actions/workflows/ci.yml)

**Website and full guide: https://light-report-production.up.railway.app** · Live board: [https://light-report-production.up.railway.app/board](https://light-report-production.up.railway.app/board)

## 30-second quickstart

You need Node 18+. Nothing to install.

```bash
# 1. Have the server run a public repo's tests (streams the log, exits 0 lit / 1 dark)
npx -y -p github:fitzyracing1/light-report light-check owner/repo

# 2. Report your own command from anywhere (exits with your command's exit code)
npx -y -p github:fitzyracing1/light-report light-run my-job -- ./my-job.sh

# 3. Read it back
curl -s https://light-report-production.up.railway.app/lights/my-job/LIGHT        # lit or dark
```

## For AI agents (Claude Code, VS Code / Copilot, Cursor)

Make the agent run the light itself before anything goes to GitHub, and keep fixing while it's dark:

```bash
cd your-repo
npx -y -p github:fitzyracing1/light-report light-check init              # Claude Code Stop hook, VS Code task + Copilot instructions, Cursor rule, AGENTS.md
npx -y -p github:fitzyracing1/light-report light-check init --pre-push   # also a git pre-push hook that blocks the push while dark
```

| tool | what `init` writes | how it works |
|---|---|---|
| Claude Code | `.claude/settings.json` Stop hook, `CLAUDE.md` block | runs the tests when Claude finishes; dark → `{"decision":"block"}` with the log, Claude keeps fixing (gives up after 8 rounds) |
| VS Code / Copilot | `.vscode/tasks.json` task `light-check`, `.github/copilot-instructions.md` block | Copilot agent is told to run `light-check . --local` before it's done |
| Cursor | `.cursor/rules/light-check.mdc` (alwaysApply), `AGENTS.md` block | same instruction for Cursor's agent |
| git | `.git/hooks/pre-push` (with `--pre-push`) | dark → push blocked (`--no-verify` skips once) |

Merges into existing files, never overwrites them; running it twice changes nothing. Optional: `--post-edit` (Claude PostToolUse hook on edits), `--folder-open` (VS Code task on folder open).

Check a local folder yourself:

```bash
npx -y -p github:fitzyracing1/light-report light-check . --local   # run here, nothing uploaded, report light local--<folder>
npx -y -p github:fitzyracing1/light-report light-check .           # upload the working tree (respects .gitignore; never .git, node_modules, .env*, keys; max 20 MB)
```

Full steps: [site → AI agents](https://light-report-production.up.railway.app/#agents).

## Lit and dark

| light | bit | when |
|---|---|---|
| **lit** ● | `0` | exit code 0, `state: "lit"`, or GitHub conclusion `success` |
| **dark** ○ | `1` | anything else — nonzero exit, cancelled, timeout — or **no report within the TTL** (stale) |

Active-low, exactly as in the [lit-dark spec](https://github.com/fitzyracing1/lit-dark/blob/main/SPEC.md). More: [site → lit & dark](https://light-report-production.up.railway.app/#lights).

## Two ways to use it

1. **Report from anywhere** — wrap a command with `light-run` or send one `curl`. → [site → report](https://light-report-production.up.railway.app/#report)
2. **Let the server run your repo** — `light-check owner/repo`. → [site → run](https://light-report-production.up.railway.app/#run)

## Step by step

### Check a repo with the runner

```bash
npx -y -p github:fitzyracing1/light-report light-check owner/repo
npx -y -p github:fitzyracing1/light-report light-check owner/repo --ref v1.2.0 --cmd 'npm ci && npm test'
```

Shows `◌ running…`, the live log, then `● lit` or `○ dark`. Exit 0 = lit, 1 = dark, 2 = the run could not start (not a light). The result becomes the light `owner--repo`.

### Read a repo's GitHub light

```bash
npx -y -p github:fitzyracing1/light-report light-check owner/repo --github
```

### Report with light-run (shell, cron, CI)

```bash
npx -y -p github:fitzyracing1/light-report light-run deploy -- ./deploy.sh
# first report prints a write token ONCE — keep it:
export LIGHT_TOKEN_DEPLOY=lr_...
```

`LIGHT_REPORT_URL` picks the server (default `https://light-report-production.up.railway.app`). GitLab:

```yaml
test:
  script:
    - npx -y -p github:fitzyracing1/light-report light-run $CI_PROJECT_NAME -- npm test
```

### Report with curl (cron, Jenkins, health checks)

```bash
./backup.sh; curl -fsS -X POST https://light-report-production.up.railway.app/lights/backup \
  -H "Authorization: Bearer $LIGHT_TOKEN" -H 'Content-Type: application/json' \
  -d "{\"exitCode\": $?, \"source\": \"cron\"}"
```

Jenkins and health-check versions: [site → report](https://light-report-production.up.railway.app/#report).

### Add a light.yml

```yaml
# light.yml — one shell command per run: line, in order; first nonzero exit = dark
run: npm ci
run: npm test
```

→ [site → light.yml](https://light-report-production.up.railway.app/#light-file)

### Add a badge

```markdown
[![light](https://light-report-production.up.railway.app/lights/owner--repo/badge.svg)](https://light-report-production.up.railway.app/lights/owner--repo)
```

### Read a LIGHT file

```bash
curl -s https://light-report-production.up.railway.app/lights/deploy/LIGHT     # lit or dark
curl -s https://light-report-production.up.railway.app/lights/deploy           # {"name","light","bit","source","reportedAt","stale"}
```

## Trials: merge a branch into a copy, flip one stable URL

`light-check trial` duplicates a repo with a branch (or same-repo PR) merged in, lights the copy with the runner,
and deploys it as its own preview. The **light-site** router keeps one stable URL on the live copy; flip it to the
trial when the trial is **lit**, flip back any time (instant rollback — the live copy keeps running).

```sh
light-check trial fitzyracing1/light-report --merge my-branch   # or --merge pr:12
light-check flip light-report <trial-id>       # 409 / exit 1 while the trial is dark; --force overrides
light-check flip light-report live             # rollback
light-check site light-report                  # target, live URL, trials
```

- Stable URL: https://light-site-production.up.railway.app (proxies to the current copy of `light-report`).
- Router API: `GET /sites/:name` public; `PUT /sites/:name`, `POST /sites/:name/trials`, `DELETE /sites/:name/trials/:id`,
  `POST /sites/:name/flip {"to":"<id>|live","force":false}` need `Authorization: Bearer $LIGHT_SITE_ADMIN_TOKEN`.
- Trial lights are `<owner>--<repo>--trial-<id>` and never overwrite the repo's own light.
- Cap: 2 trials per site; a new trial cleans up the oldest one that isn't the target (Railway service, `trial/<id>` branch, router entry).
- v1 is for your own repos: it needs `gh` (repo owner = your login), `RAILWAY_API_TOKEN` (create services/domains),
  `RAILWAY_TOKEN` (project token, deploy), `LIGHT_TRIAL_PROJECT_ID`, `LIGHT_TRIAL_ENVIRONMENT_ID`, `LIGHT_SITE_ADMIN_TOKEN`.
- Run the router yourself: `node bin/light-site.mjs` (or `Dockerfile.site`) with `LIGHT_SITE_ADMIN_TOKEN`,
  `LIGHT_SITE_SEED_LIVE=<live url>`, `DATA_DIR`.
- Design, data model, security and what a multi-tenant version needs: [docs/TRIALS.md](docs/TRIALS.md).

## API

| | |
|---|---|
| `POST /lights/:name` | `{exitCode}` or `{state}`, `source`, `detail?`; Bearer token after the first report |
| `POST /lights/:name/github` | `{repo}` — GitHub as a source |
| `GET /lights/:name` · `/LIGHT` · `/badge.svg` | JSON · one word · badge |
| `GET /lights` · `GET /board` | all lights as JSON · HTML board |
| `POST /runs` | `{repo, ref?, command?}` — queue a run |
| `POST /runs/upload` | gzip'd JSON `{name, command?, files}` — run an uploaded folder |
| `GET /runs/:id` · `/runs/:id/log` · `GET /runs` | status · live log · recent runs |

Full table: [site → API](https://light-report-production.up.railway.app/#api). Auto-detection order (light.yml → npm → cargo → python → make): [site → detection](https://light-report-production.up.railway.app/#detect).

## Limits and safety

The runner is **not a full sandbox** — public GitHub repos only; jobs run as an unprivileged user in a wiped temp dir with a clean environment, but share the container's network, CPU and memory. 10-minute cap, one job at a time, 6 runs per hour per IP, logs kept in memory only. Anyone can run any public repo, which writes its `owner--repo` light. Details: [site → limits](https://light-report-production.up.railway.app/#limits).

## Is this replacing GitHub Actions?

No — it's a small runner plus a scoreboard. GitHub is one optional source. [FAQ](https://light-report-production.up.railway.app/#faq)

## Run your own

```bash
DATA_DIR=./data node server.mjs     # no dependencies; Dockerfile included
```

Env: `PORT`, `DATA_DIR`, `LIGHT_TTL_SECONDS` (86400), `RUN_TIMEOUT_SECONDS` (600), `RUN_CONCURRENCY` (1), `RUN_MAX_QUEUE` (10), `RUNS_PER_IP_PER_HOUR` (6), `RUN_LOG_BYTES` (1000000), `RUN_AS_UID`/`RUN_AS_GID`, `PUBLIC_URL`.

## License

MIT © 2026 Joshua Almeida

## Plans

This project is free, and its license stays as is. Support it through [GitHub Sponsors](https://github.com/sponsors/fitzyracing1):

- **Free**: use the code, community support.
- **Pro ($49/month)**: priority issues and support.
- **Team ($199/month)**: priority support for your team plus early access.
