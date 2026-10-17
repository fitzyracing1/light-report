# Running light-report as a service (commit-live trial)

Throwaway branch `try/service-launch`. Spec: [commit-live SERVICES.md](https://github.com/fitzyracing1/commit-live/blob/try/service-launch/SERVICES.md).

- **Start command:** `npm start → node server.mjs`
- **Notes:** Dockerfile; already runs on Railway (light-report-production).
- **Light:** lit = every GitHub Actions run on the commit succeeded (exit 0); dark = anything else.
- **What runs now:** `.github/workflows/commit-live-service.yml` waits for the commit's light, then runs the
  commit-live launcher in **dry run with the mock host** (in-memory GitHub, nothing launched, no secrets).
  Only lit commits launch; dark commits are refused. The `go-live` job runs only when a person presses
  *Run workflow* and is also a dry run.

## What a real launch needs

1. A host account (Railway adapter is built): a **workspace token** as the repo secret `RAILWAY_TOKEN`
   (project tokens are refused), plus `RAILWAY_PROJECT_ID`, `RAILWAY_SERVICE_ID`, `RAILWAY_LIVE_ENVIRONMENT_ID`
   and `RAILWAY_LIVE_URL` for this service.
2. The workflow switched to `--host railway`, without `--dry-run`, with `COMMIT_LIVE_REAL: 'true'` and
   `deployments: write` + `statuses: write` permissions, and a `commit-live` status on each commit
   (the deployment uses `required_contexts: ["commit-live"]`).
3. The host's own auto-deploy-on-push turned off for the live service, so dark commits can't go live behind
   commit-live's back.
4. A `go-live-approval` environment with required reviewers on the go-live job (public repos on free plans).
5. Previews clone the live environment's variables: point them at a staging source or override secrets first.
6. Any runtime variables the service needs (see notes above) set on the host, never in the repo.
