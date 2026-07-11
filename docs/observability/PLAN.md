# Observability plan — YIL-12

Status: active. Owner: founding engineer. Updated: 2026-07-11.

## Goal

Make the marketplace debuggable in production for a solo founder doing the on-call
rotation. Three jobs to be done:

1. **See what broke** — error tracking with enough context to reproduce.
2. **Know before users do** — uptime + readiness checks that page us on real outages.
3. **Diagnose quickly** — structured logs we can grep, plus a runbook for the
   incidents we expect to hit in the first 90 days.

Everything below is wired into the app — see the integration map for which files
implement each piece.

## Stack picks

| Concern              | Pick                  | Why                                                                                                                                                |
|----------------------|-----------------------|----------------------------------------------------------------------------------------------------------------------------------------------------|
| Error tracking       | Sentry (`@sentry/nextjs`) | First-party Next.js support (App Router, edge, server actions), generous free tier, source maps, release tracking tied to git SHA.                  |
| Structured logs      | `pino`                | Fastest Node JSON logger; ships with redaction support; trivial to ship to any aggregator via a `pino.transport()`.                                |
| Local dev logs       | `pino-pretty`         | Human-readable output in `npm run dev`.                                                                                                            |
| Uptime (external)    | Better Stack (or UptimeRobot as fallback) | Public HTTP probe every 60s from ≥3 regions; SMS/email alerts; status page embed. We pick the service on the deploy host, not in this repo.       |
| Uptime (in-repo probe) | GitHub Actions cron  | Free, version-controlled, runs from a clean network. Acts as a second probe and a record of historical uptime in the Actions run log.              |
| Logs aggregator      | Logs provider on the deploy host (e.g. Better Stack Logs, or stdout → host log drain) | We do not commit to a logs SaaS in-repo. Pino writes JSON to stdout; whatever runs the container collects it.                                       |
| Source maps          | `@sentry/nextjs` auto-uploads on `next build` | No manual upload step. Requires `SENTRY_AUTH_TOKEN` in CI secrets.                                                                                  |

## Integration map

| Surface                            | File                                               | Purpose                                                          |
|------------------------------------|----------------------------------------------------|------------------------------------------------------------------|
| Browser error capture              | `sentry.client.config.ts`                          | Initializes Sentry in the browser; sample rate 100% in dev, configurable per env. |
| Server / route handler errors      | `sentry.server.config.ts`                          | Initializes Sentry in Node; hooks into `unhandledRejection`.     |
| Next.js instrumentation hook       | `instrumentation.ts`                               | Registers Sentry before any route handler runs (Next 13+ convention). |
| Structured logger                  | `src/lib/logger.ts`                                | Single pino instance; redacts PII; exposes `requestLogger()`.   |
| PII redaction                      | `src/lib/observability/redact.ts`                  | Field/path redaction used by both logger and Sentry `beforeSend`.|
| Request/response middleware        | `src/lib/observability/request-log.ts`             | Logs every HTTP request with method, route, status, duration, requestId. |
| Health (process + DB liveness)     | `src/app/api/health/route.ts` (existing)           | Returns 200 only if DB reachable. Used by Docker `HEALTHCHECK`.  |
| Readiness (deep checks)            | `src/app/api/ready/route.ts`                       | Returns 200 only if app can serve traffic — DB + auth config + Stripe config sanity. |
| Uptime probe                       | `.github/workflows/uptime.yml`                     | Hits `/api/ready` every 5 min; fails CI on 5xx (recorded in Actions history). |
| Alert routing matrix               | `docs/observability/ALERTS.md`                     | Who pages whom, when, escalation.                                |
| Incident playbook                  | `docs/observability/RUNBOOK.md`                    | Top 5 incidents — symptoms, diagnosis, mitigation.               |
| Logging standard                   | `docs/observability/LOGGING.md`                    | Levels, fields, redaction policy.                                 |

## Environment variables

Add to `.env.example` (already done in this commit) and provision in each
environment (dev, preview, prod):

```
# Sentry
SENTRY_DSN=                                # leave blank to disable Sentry (dev only)
SENTRY_ENVIRONMENT=development             # development | preview | production
SENTRY_TRACES_SAMPLE_RATE=0.1              # 100% in dev, 10% in prod by default
SENTRY_AUTH_TOKEN=                         # CI-only, for source map upload

# Logging
LOG_LEVEL=info                             # trace|debug|info|warn|error|fatal
LOG_PRETTY=false                           # true in dev, false in prod
LOG_REDACT_PATHS=password,*.secret,token,*token*,authorization,cookie,set-cookie

# Uptime
UPTIME_PUBLIC_URL=https://yil-marketplace.example.com
```

## Cost ceiling

For a pre-launch marketplace with <10k MAU the all-in bill should be <$20/mo:

- Sentry free tier: 5K errors / 10K spans / month.
- Better Stack free tier: 5 monitors at 1-min cadence.
- GitHub Actions cron: ~$0 (free for public repos; private repos 2000 min/mo
  free, we use ~290 min/mo at 5-min cadence).

If we exceed any of those, the right move is *fewer* alerts with better signal,
not upgrading.

## What is intentionally NOT in scope

- **Distributed tracing across services.** We have one service. Add OpenTelemetry
  only when we add a second service (worker / search indexer).
- **Real-user monitoring dashboards.** Sentry's performance tab covers p50/p95
  for the top routes — that is enough at this stage.
- **Synthetic browser checks.** The HTTP probe + Sentry's session replay (free
  tier includes 50 replays/mo) covers the cases we care about pre-launch.
- **Status page.** We are not paying for one yet. If we exceed 1 incident/week
  we revisit.

## Verification

- `/api/health` returns 200 with DB up, 503 otherwise (existing — verified by
  CI preview job).
- `/api/ready` returns 200 in a clean prod-like environment with all required
  env vars set; 503 otherwise. Tested in CI preview job (added in this commit).
- Sending an unhandled error to any route logs a structured error event AND
  surfaces it in Sentry (when `SENTRY_DSN` is set).
- Sending an unhandled error with `SENTRY_DSN` unset logs the structured error
  and does NOT crash the process.
- `.github/workflows/uptime.yml` is on schedule and a 5xx fails the run.