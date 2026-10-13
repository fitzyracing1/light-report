# light-report

Report a CI **light** from anywhere — a shell script, cron, Jenkins, GitLab, a health check, or GitHub — and read it back as JSON, a one-word file, or a badge. It can also **run** a public repo's tests for you and turn the result into a light.

A light is one bit, active-low, same rule as [fitzyracing1/lit-dark](https://github.com/fitzyracing1/lit-dark/blob/main/SPEC.md):

| light | bit | when |
|---|---|---|
| **lit** ● | `0` | exit code 0, `state: "lit"`, or GitHub conclusion `success` |
| **dark** ○ | `1` | anything else: nonzero exit, cancelled, timed out, or no report within the TTL (stale) |

No dependencies. Node 18+.

Live instance: https://light-report-production.up.railway.app (the default for `light-run` when `LIGHT_REPORT_URL` is unset). Example badges: ![demo-lit](https://light-report-production.up.railway.app/lights/demo-lit/badge.svg) ![demo-dark](https://light-report-production.up.railway.app/lights/demo-dark/badge.svg)

## Report a light

### With `light-run` (wraps any command)

```bash
export LIGHT_REPORT_URL=https://YOUR-HOST          # your light-report server
npx -y -p github:fitzyracing1/light-report light-run nightly-backup -- ./backup.sh
```

`light-run` runs the command, reports its exit code (0 → lit, anything else → dark), and exits with the **same** exit code, so it fits inside any script or CI step.

The first report for a new name creates the light and prints a **write token once**. Keep it; later reports need it:

```bash
export LIGHT_TOKEN_NIGHTLY_BACKUP=lr_...   # or LIGHT_TOKEN=lr_...
```

### With curl (any shell, cron, Jenkins, GitLab)

```bash
./deploy.sh; curl -fsS -X POST "$LIGHT_REPORT_URL/lights/deploy" \
  -H "Authorization: Bearer $LIGHT_TOKEN" -H 'Content-Type: application/json' \
  -d "{\"exitCode\": $?, \"source\": \"shell\"}"
```

**cron**

```cron
0 3 * * * /opt/backup.sh; curl -fsS -X POST https://YOUR-HOST/lights/backup -H "Authorization: Bearer lr_..." -H 'Content-Type: application/json' -d "{\"exitCode\": $?, \"source\": \"cron\"}"
```

**Jenkins** (declarative pipeline)

```groovy
post {
  success { sh 'curl -fsS -X POST $LIGHT_REPORT_URL/lights/$JOB_NAME -H "Authorization: Bearer $LIGHT_TOKEN" -H "Content-Type: application/json" -d \'{"state":"lit","source":"jenkins"}\'' }
  unsuccessful { sh 'curl -fsS -X POST $LIGHT_REPORT_URL/lights/$JOB_NAME -H "Authorization: Bearer $LIGHT_TOKEN" -H "Content-Type: application/json" -d \'{"state":"dark","source":"jenkins"}\'' }
}
```

**GitLab CI**

```yaml
test:
  script:
    - npx -y -p github:fitzyracing1/light-report light-run $CI_PROJECT_NAME -- npm test
  variables:
    LIGHT_REPORT_URL: https://YOUR-HOST   # put LIGHT_TOKEN in masked CI/CD variables
```

**Health check** (every 5 minutes; set `LIGHT_TTL_SECONDS` so a silent checker goes dark)

```bash
curl -fsS https://example.com/health >/dev/null; curl -fsS -X POST $LIGHT_REPORT_URL/lights/example-health -H "Authorization: Bearer $LIGHT_TOKEN" -H 'Content-Type: application/json' -d "{\"exitCode\": $?, \"source\": \"healthcheck\"}"
```

### From GitHub (optional adapter)

GitHub is just one more source. The server reads the newest completed push run and maps it once: `success` → lit, anything else → dark.

```bash
curl -fsS -X POST $LIGHT_REPORT_URL/lights/lit-dark/github -H "Authorization: Bearer $LIGHT_TOKEN" \
  -H 'Content-Type: application/json' -d '{"repo":"fitzyracing1/lit-dark"}'
```

If GitHub can't be reached or has no run, that is an error (HTTP 502), not a dark light — as in the spec.

## Run tests for a public repo (the runner)

```bash
npx -y -p github:fitzyracing1/light-report light-check fitzyracing1/light-report
npx -y -p github:fitzyracing1/light-report light-check owner/repo --ref v1.2.0 --cmd 'make check'
npx -y -p github:fitzyracing1/light-report light-check owner/repo --github   # just read the GitHub light
```

`light-check` queues a run, streams the log live, shows `◌ running…` and then `● lit` or `○ dark`, and exits **0 for lit, 1 for dark** (2 if the run could not be submitted — that is not a light). The result is also saved as a light named `owner--repo` with source `light-report-runner`, so it shows on the board and as a badge: `/lights/owner--repo/badge.svg`.

Raw HTTP:

```bash
curl -s -X POST $LIGHT_REPORT_URL/runs -H 'Content-Type: application/json' -d '{"repo":"owner/repo","ref":"main","command":"npm test"}'
# → {"id":"9f2c…","status":"queued",…}
curl -N $LIGHT_REPORT_URL/runs/9f2c…/log     # live log (chunked text) until the run ends
curl -s $LIGHT_REPORT_URL/runs/9f2c…         # {"status":"done","light":"lit","bit":0,"exitCode":0,"seconds":12.3,…}
curl -s $LIGHT_REPORT_URL/runs               # recent runs
```

`ref` and `command` are optional. `ref` must be a branch or tag (the clone is `git clone --depth 1 --branch <ref>`; commit SHAs are not supported).

### What command runs

If you don't give a `command`, the runner looks in this order:

1. A **light file** — `light.yml`, `light.yaml` or `.light` in the repo root (format below).
2. `package.json` with a `test` script → `npm ci` (if there is a lockfile, else `npm install`) then `npm test`.
3. `Cargo.toml` → `cargo test` — only if the runner has a Rust toolchain. The hosted runner does not, so these repos read dark with "no Rust toolchain".
4. `pyproject.toml` / `setup.py` / `requirements.txt` → a fresh venv, `pip install` the requirements and the project, then `pytest`.
5. A `Makefile` with a `test:` target → `make test`.

Nothing found → dark, with the reason in the log.

### Light file format

One shell command per `run:` line, run in order from the repo root; the first command that exits nonzero stops the run and makes the light dark. `#` starts a comment, other lines are ignored (so a light file can sit next to YAML you already have).

```yaml
# light.yml
run: npm ci
run: npm run lint
run: npm test
```

### Limits and safety — read this

This is a convenience runner, **not a full sandbox**. Only point it at code you would be willing to run on a small shared box.

- **Public GitHub repos only.** Clones are anonymous over HTTPS; private repos simply don't clone.
- Jobs run as an **unprivileged user** (uid 1000) in a fresh temp directory that is **wiped** afterwards.
- The job's environment is built from scratch (`PATH`, `HOME`, `LANG`, `CI=true`): no Railway variables, tokens or other server secrets reach the job. The light store is not readable by the job.
- **Hard timeout** of 10 minutes (`RUN_TIMEOUT_SECONDS`); the whole process group is killed and the light is dark.
- **One job at a time** (`RUN_CONCURRENCY`), up to 10 waiting (`RUN_MAX_QUEUE`), **6 runs per hour per IP** (`RUNS_PER_IP_PER_HOUR`).
- Logs are capped at **1 MB** (`RUN_LOG_BYTES`) and kept in memory for the last 100 runs; they are gone after a restart (the lights stay).
- Jobs share the container's kernel, CPU, memory and network — there is no network isolation and no per-job memory limit. Toolchains available: Node 22/npm, Python 3, git, make. No Rust, Go, Java or Docker.
- Anyone can start a run for any public repo, so the runner can overwrite a light named `owner--repo`. Use other names for lights you report yourself.

## Read a light

| URL | gives |
|---|---|
| `GET /lights/:name` | `{"name","light":"lit"\|"dark","bit":0\|1,"source","detail","reportedAt","stale"}` |
| `GET /lights/:name/LIGHT` | plain `lit` or `dark` |
| `GET /lights/:name/badge.svg` | badge: `![light](https://YOUR-HOST/lights/NAME/badge.svg)` |
| `GET /lights` | every light as JSON |
| `GET /` | a board of all lights |

A name nobody has reported yet reads as dark and stale.

## Report body

`POST /lights/:name` with JSON `{"exitCode": 0}` **or** `{"state": "lit"|"dark"}` (GitHub conclusions like `"success"` are accepted), plus `source` and optional `detail`. Token goes in `Authorization: Bearer <token>` (or `X-Light-Token`). Tokens are stored only as SHA-256 hashes.

## Run your own

```bash
node server.mjs                  # PORT=8080, lights kept in memory
DATA_DIR=./data node server.mjs  # lights saved to ./data/lights.json
```

| env | default | |
|---|---|---|
| `PORT` | `8080` | |
| `DATA_DIR` | `RAILWAY_VOLUME_MOUNT_PATH` | where `lights.json` lives; unset = memory only |
| `LIGHT_TTL_SECONDS` | `86400` | no report for this long → dark (stale); `0` = never stale |

**Railway:** create a project and service, add a volume mounted at `/data`, set `RAILWAY_RUN_UID=0`, generate a domain (target port 8080), then `railway up` (a project token in `RAILWAY_TOKEN` works for `railway up --ci --service <id>`). The `Dockerfile` sets `DATA_DIR=/data`.

## License

MIT © 2026 Joshua Almeida
