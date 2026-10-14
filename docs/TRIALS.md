# Trials: merge a branch into a copy, light it, and move one stable URL

A **trial** is a copy of a repo with one branch (or pull request) merged in. light-report builds and tests the
copy (it gets its own **lit** / **dark** light), deploys it as its own preview, and a small router — **light-site** —
keeps **one stable URL** that points at whichever copy is current. Flip the URL to a trial when it is lit; flip
back at any time, instantly.

```
            light-check trial owner/repo --merge feature
                         │
   ┌─────────────────────┼──────────────────────────────┐
   │ 1 duplicate+merge   │ 2 light            3 preview │
   │ branch trial/<id>   │ runner → light     Railway   │
   │ = main + feature    │ <o>--<r>--trial-<id>  service  │
   └─────────────────────┴──────────────┬───────────────┘
                                        │ 4 register trial
                 stable URL  ┌──────────▼──────────┐
   users ───────────────────▶│  light-site router  │──▶ live copy   (target = live)
                             │  /sites/:name/flip  │──▶ trial <id>  (target = <id>, only if lit)
                             └─────────────────────┘
```

## Pieces

| piece | v1 (this repo, own repos only) | multi-tenant version |
|---|---|---|
| **duplicate** | branch `trial/<id>` in the same repo, pushed with the caller's `gh` login | GitHub App installed per repo; installation token scoped to `contents:write` on that repo only; optional separate `<repo>-trial-<id>` repo for fork PRs |
| **merge** | `git merge --no-ff <branch>` onto the default branch; a merge that does not apply cleanly stops the trial, nothing is pushed | same, plus PR head SHA pinning (merge exactly the SHA that was reviewed), merge-queue style re-merge when main moves |
| **light** | the existing runner checks `trial/<id>`; the light is `<owner>--<repo>--trial-<id>` so a trial never touches the repo's main light | runner in a real sandbox (gVisor/Firecracker), per-tenant quotas, signed light records |
| **preview deploy** | one Railway service per trial (`<repo>-trial-<id>`), `railway up` of the merged tree, own `*.up.railway.app` domain | per-tenant Railway project (or other host) with budget caps; build from the pushed SHA, not a local tree |
| **router / stable URL** | `light-site` Railway service, reverse proxy to the current target, state in a JSON file on a volume | host-based routing (one hostname per site), custom domains + TLS, health-checked targets, HA (2+ replicas, shared state) |
| **lit gate** | `POST /sites/:name/flip {to}` asks light-report for the trial's light at flip time; dark → 409 unless `force:true` | gate also requires the preview to answer health checks; optional required-reviewers |
| **rollback** | `flip <site> live` — the live copy keeps running, so rollback is one pointer write | keep the last N targets warm; automatic rollback when the stable URL's health check goes dark |
| **cleanup** | at most **2** trials per site; a new trial removes the oldest one that is not the current target (router entry, Railway service, `trial/<id>` branch) | TTL on trials, nightly sweep, cost reporting per tenant |

## Data model (router, `sites.json`)

```json
{ "sites": { "light-report": {
    "live":   "https://light-report-production.up.railway.app",
    "target": "live",                       // or a trial id
    "trials": { "3fa9c1": { "url": "https://light-report-trial-3fa9c1-production.up.railway.app",
                            "light": "fitzyracing1--light-report--trial-3fa9c1",
                            "branch": "trial/3fa9c1", "service": "<railway service id>",
                            "createdAt": "2026-10-14T01:50:00Z" } },
    "history": [ { "at": "…", "from": "live", "to": "3fa9c1", "light": "lit", "forced": false } ] } } }
```

## Router API

| | | auth |
|---|---|---|
| `GET /sites` · `GET /sites/:name` | target, live URL, trials, last 10 flips | public |
| `PUT /sites/:name {live}` | create a site / change its live URL | admin |
| `POST /sites/:name/trials {id,url,light,branch,service}` | register a trial (409 past 2) | admin |
| `DELETE /sites/:name/trials/:id` | unregister; if it was the target, the URL goes back to live | admin |
| `POST /sites/:name/flip {to, force?}` | `to` = trial id or `live`; dark trial → 409 unless `force:true` | admin |
| anything else | reverse-proxied to the default site's current target (`x-light-site: <site>:<target>` header added) | — |

## Security

- **Admin token** (`LIGHT_SITE_ADMIN_TOKEN`) lives only as a Railway variable on `light-site` and in the operator's
  environment. It is compared in constant time and never written to `sites.json`, responses or logs.
- Target URLs must be `http(s)` origins with no credentials; only the origin is kept, so a registration cannot smuggle a path.
- v1 refuses to trial a repo whose owner is not the `gh` login (or `LIGHT_TRIAL_OWNERS`). It only pushes `trial/*` branches.
- The trial is **untrusted code until lit**, and lit only means "its tests passed" — the runner is not a full sandbox
  (see the README). The gate stops accidental flips, not a malicious branch.
- The proxy strips hop-by-hop headers and forwards the client's request otherwise unchanged; the target sees `x-forwarded-host`.
- Railway: the workspace token creates/deletes services; the project token only deploys. Neither is printed.

## What a real multi-tenant version needs

1. A **GitHub App** (per-repo install, short-lived installation tokens) instead of a personal `gh` login; webhooks to
   start a trial on PR label/comment and to post the trial light as a check run.
2. **Isolation**: sandboxed builds, a separate Railway project (or provider account) per tenant, egress limits.
3. **Ownership** on the router: sites belong to tenants; per-site tokens; audit log of flips.
4. **Host-based routing + custom domains** (one stable hostname per site) instead of one default site per router.
5. **State** in a database (Postgres) with 2+ router replicas; flips are a single-row update.
6. **Quotas and billing**: trial cap per tenant, TTL, preview sleep-when-idle, cost shown before deploy.
7. **Data**: trials share nothing stateful with live in v1 (no volume). Real apps need per-trial databases or branching.
