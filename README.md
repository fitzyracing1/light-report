# light-report

Report a CI **light** from anywhere — a shell script, cron, Jenkins, GitLab, a health check, or GitHub — and read it back as JSON, a one-word file, or a badge.

A light is one bit, active-low, same rule as [fitzyracing1/lit-dark](https://github.com/fitzyracing1/lit-dark/blob/main/SPEC.md):

| light | bit | when |
|---|---|---|
| **lit** ● | `0` | exit code 0, `state: "lit"`, or GitHub conclusion `success` |
| **dark** ○ | `1` | anything else: nonzero exit, cancelled, timed out, or no report within the TTL (stale) |

No dependencies. Node 18+.

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

**Railway:** `railway init --name light-report && railway up`, add a volume mounted at `/data`, set `RAILWAY_RUN_UID=0` if needed, then `railway domain`. The `Dockerfile` sets `DATA_DIR=/data`.

## License

MIT © 2026 Joshua Almeida
