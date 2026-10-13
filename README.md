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

## API

| | |
|---|---|
| `POST /lights/:name` | `{exitCode}` or `{state}`, `source`, `detail?`; Bearer token after the first report |
| `POST /lights/:name/github` | `{repo}` — GitHub as a source |
| `GET /lights/:name` · `/LIGHT` · `/badge.svg` | JSON · one word · badge |
| `GET /lights` · `GET /board` | all lights as JSON · HTML board |
| `POST /runs` | `{repo, ref?, command?}` — queue a run |
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
