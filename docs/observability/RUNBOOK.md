# Incident runbook — YIL-12

For the solo founder on-call. Five incidents cover ≥80% of the outages we
expect to hit in the first 90 days of running a marketplace.

Each section follows the same shape:

1. **Symptoms** — what users / alerts say.
2. **First 60 seconds** — what to do *before* you start investigating.
3. **Diagnose** — concrete queries / checks, in order.
4. **Mitigate** — the smallest action that restores service.
5. **Follow-up** — the thing that prevents this becoming the third ticket.

General rules:

- The on-call is **one person** (the founder) until we hire engineer #2. Pager
  rules in `ALERTS.md` ensure we don't get woken for noise.
- When in doubt: **ship a fix, then write the postmortem.** A perfect diagnosis
  with users locked out is a worse outcome than a quick mitigation with a
  follow-up ticket.
- Every incident gets a follow-up issue. Even "self-healed" outages.
- The on-call treats the runbook as living doc — every mitigation that worked
  gets folded in here within 24h.

---

## Incident 1 — Payments down (Stripe webhook failures / payment intent errors)

**Why this is #1**: a marketplace that can't take money is dead in the water.
Even a 10-minute outage during checkout is a lost-conversion event and a
refund-fight waiting to happen.

### Symptoms

- Sentry alert: `PaymentIntent.create` errors spike, or
  `stripe.webhook.constructEvent` throws `No signatures found matching the
  expected signature`.
- Users in `#support` (or email) say "I paid but my order shows pending."
- `/api/ready` may still be 200 — Stripe is a third-party dependency.

### First 60 seconds

1. Acknowledge the alert in Sentry (mutes repeat pages for 30 min).
2. Open the Stripe dashboard → **Logs** → filter `status >= 400`. If empty,
   the outage is on our webhook receiver, not Stripe.
3. If our `/api/stripe/webhook` is returning 5xx, **do not** retry from the
   Stripe dashboard — that re-sends the same events. Wait for the fix.

### Diagnose

```bash
# 1. Are webhooks reaching us at all?
# Tail the prod logs (whatever your host exposes) and filter:
"route=/api/stripe/webhook"

# 2. Is the webhook signature failing?
# Sentry search:
environment:production "No signatures found matching the expected signature"

# 3. Is STRIPE_WEBHOOK_SECRET rotated?
# In your secret store, compare the value to the one Stripe shows under
# Developers → Webhooks → [endpoint] → "Signing secret".

# 4. Did we deploy right before the outage?
git log --oneline -5 -- src/app/api/stripe/webhook/

# 5. Is Stripe itself down?
# Check https://status.stripe.com
```

### Mitigate

In order of how common each cause is:

1. **Secret rotation drift.** Re-paste the correct `STRIPE_WEBHOOK_SECRET` into
   the secret store, redeploy. Webhooks queue in Stripe for up to 24h; we do
   not lose money unless we ignore the alert for that long.
2. **Deploy broke the handler.** Revert the most recent commit touching
   `src/app/api/stripe/webhook/`. Do NOT push a "fix forward" under pressure —
   the rollback is the smallest correct action.
3. **Stripe is down.** There is nothing to do but wait and post a status note.
   Do not refund proactively — Stripe events are durable.

### Follow-up

If the root cause was a missing test for webhook signature rotation, add one
to `src/app/api/stripe/webhook/`. If it was a deploy regression, add a smoke
test that exercises the webhook handler in the CI preview job.

---

## Incident 2 — Auth outage (login / signup / session broken)

**Why this is #2**: nobody can buy or sell. The marketplace goes to zero.

### Symptoms

- Sentry alert: `auth.signIn` throws, or session validation rejects valid
  cookies.
- Login form submits but redirects back to `/login` with no error.
- `/api/ready` is 200 (auth uses Postgres + cookies; usually DB is fine).

### First 60 seconds

1. Acknowledge the Sentry alert.
2. Try to sign in yourself in an incognito window. If it works, the report is
   about a single user — go investigate that account. If it fails, proceed.
3. Check `/api/health`. If 503, the root cause is Postgres — see Incident 3.

### Diagnose

```bash
# 1. Is the sessions table growing without bound?
psql "$DATABASE_URL" -c "select count(*) from sessions;"

# 2. Are there unhandled errors on /api/auth/*?
# Sentry search:
environment:production transaction:/api/auth/*

# 3. Is NODE_ENV flipped to "production" with dev secret keys?
# Check the rendered config page or env dump endpoint (NOT exposed publicly —
# use the internal debug page in /admin).

# 4. Did the cookie domain change?
# Recent deploys: `git log -p -- src/lib/auth.ts`
```

### Mitigate

1. **Sessions table unbounded.** Truncate after backing up; redeploy with the
   scheduled cleanup job from `cron/sessions-cleanup.ts` if it is missing.
2. **Env var mismatch.** Paste the correct `AUTH_SECRET` / OAuth client IDs.
   This invalidates all sessions — users get logged out, but they can log back
   in.
3. **Deploy regression on auth lib.** Rollback per `git revert`.

### Follow-up

If the root cause was a missing integration test for the auth flow, add one
to `src/lib/auth.test.ts` covering sign-in + sign-out + cookie persistence.

---

## Incident 3 — Database exhaustion / connection pool saturation

**Why this is #3**: Postgres going away turns every other incident from
"one feature broken" into "everything broken." The health endpoint will catch
this first if wired correctly.

### Symptoms

- `/api/health` returns 503 (DB ping fails) or times out.
- `/api/ready` returns 503 with `db.error: "timeout"`.
- Sentry: `Pool exhausted`, `Connection terminated unexpectedly`, or
  `remaining connection slots are reserved`.

### First 60 seconds

1. Acknowledge all open Sentry alerts — they will probably auto-resolve once
   the pool is healthy.
2. **Do not** redeploy. Restarts do not free connections held by other app
   instances. They can make it worse.

### Diagnose

```bash
# 1. How many connections are open, and who has them?
psql "$DATABASE_URL" -c "
  select state, count(*), max(now() - state_change) as oldest
  from pg_stat_activity
  where datname = current_database()
  group by state
  order by count(*) desc;"

# 2. Are there long-running queries?
psql "$DATABASE_URL" -c "
  select pid, now() - query_start as duration, state, query
  from pg_stat_activity
  where state != 'idle'
    and datname = current_database()
  order by duration desc
  limit 10;"

# 3. Is the host Postgres hitting its connection ceiling?
psql "$DATABASE_URL" -c "show max_connections;"

# 4. Are we leaking connections (pool growing across deploys)?
# The singleton pool in src/db/client.ts is cached on globalThis — HMR can
# leak. In prod each container starts fresh, so a leak here is a code bug.
```

### Mitigate

1. **Kill the long-running query** by its PID:
   ```sql
   select pg_cancel_backend(<pid>);   -- graceful
   select pg_terminate_backend(<pid>); -- if it ignores cancel
   ```
2. **Lower pool size per app instance** if `max_connections` is hit:
   `PGPOOL_MAX=5` env var, restart one instance at a time, watch counts drop.
3. **Restart Postgres last.** Only if everything above failed. Drain traffic
   to 0 first by scaling the app deployment to zero replicas.

### Follow-up

If the root cause was a missing transaction boundary (query running outside a
transaction holding a connection), add a `withTransaction()` helper to
`src/db/`. If it was a runaway cron, kill the cron and add a concurrency
limit.

---

## Incident 4 — Search down / index lag

**Why this is #4**: search is how buyers find anything. A marketplace without
search is a wall of unsorted listings. We do not get a Sentry 5xx for "search
returns nothing" — we get silent conversion drops. The runbook has to cover
both.

### Symptoms

- Sentry: `SearchBackend.search` throws, OR
- `/api/ready` returns 200 but `search.ok: false`.
- Users report "search returns no results" for queries that should match.
- Listing detail pages still load — search is its own subsystem.

### First 60 seconds

1. If `/api/ready` says search is down, acknowledge the alert and proceed.
2. If `/api/ready` says search is fine but users complain, the issue is index
   lag (a recently-listed item is missing) — different fix.

### Diagnose

```bash
# 1. Is the FTS index present?
psql "$DATABASE_URL" -c "\di listings_*"

# 2. Does the search function return hits for a known title?
psql "$DATABASE_URL" -c "select id, title from listings where to_tsvector('english', title) @@ plainto_tsquery('english', 'sofa');"

# 3. Is there index bloat (vacuum not running)?
psql "$DATABASE_URL" -c "
  select relname, n_live_tup, n_dead_tup, last_autovacuum
  from pg_stat_user_tables
  where relname like 'listings%';"

# 4. Are we hitting query timeouts?
# Sentry: search transactions with span_status: "internal_error"
```

### Mitigate

1. **Missing index** (someone dropped it in a migration). Restore from
   `db/migrations/0002_search_index.sql`; redeploy.
2. **Index bloat**. Run `VACUUM ANALYZE listings` (does not lock).
3. **Search returns 0 for valid queries**. Inspect `SearchQuery.ts` — the
   `to_tsquery` call may be quoting user input incorrectly. Rollback the last
   change to `src/search/`.

### Follow-up

Add a synthetic check that posts a listing and verifies it surfaces in search
within 5 seconds. This is the only way we catch "search is up but lagging"
before users do.

---

## Incident 5 — Image upload / object storage failure

**Why this is #5**: sellers who cannot post photos do not post listings. Two
days of broken uploads means the marketplace's supply side decays. Buyers
leave. Death spiral.

### Symptoms

- Sentry: `PutObject` / `CreateMultipartUpload` errors from S3 (or whatever
  object store we use).
- `/api/ready` may report `storage.ok: false` once the storage check is added.
- New listings get a placeholder image; old listings still render.

### First 60 seconds

1. Check the storage provider's status page first. (S3, R2, Spaces, etc.)
2. If the provider is up, the outage is on us — credentials or CORS.

### Diagnose

```bash
# 1. Are credentials still valid?
# Test with the storage CLI using the same creds:
aws --endpoint-url "$S3_ENDPOINT" s3 ls "$S3_BUCKET"

# 2. Is the bucket reachable from the app's network?
# From inside the app container:
curl -fsS "$S3_ENDPOINT/$S3_BUCKET"

# 3. Is CORS blocking browser uploads?
# Open dev tools → Network → look for the preflight OPTIONS failing.
```

### Mitigate

1. **Provider outage.** There is no fix — wait. Sellers can still post
   listings without images (we degrade gracefully; the listing is created with
   `cover_image: null`). Communicate this on the status note.
2. **Credentials rotated / wrong.** Re-paste the storage secrets, redeploy.
3. **CORS** misconfigured. Add the deploy hostname to the bucket's allowed
   origins.

### Follow-up

- Add a 24h rotation alert on the storage credentials.
- Add a synthetic check that uploads a 1KB image and asserts the upload
  completes within 5s. This catches both provider outages and credential drift.

---

## Incident triage cheatsheet

| Symptom                                | First incident to check |
|----------------------------------------|--------------------------|
| `/api/health` 503                      | Incident 3 (DB)          |
| `/api/ready` 503 with `db.ok: true`    | Look at the failing sub-check — usually storage or auth config. |
| Login broken, health 200               | Incident 2 (Auth)        |
| Payment errors spike                   | Incident 1 (Payments)    |
| Listings page empty                    | Incident 4 (Search)      |
| Image upload 4xx/5xx                   | Incident 5 (Storage)     |
| Random 5xx on one route                | Open Sentry for that transaction; usually a single bad query.    |

## Postmortem template

After any incident that lasted >15 min or paged any user:

```
## Incident YYYY-MM-DD: <short title>
- Duration: HH:MM (first alert → mitigation deployed)
- Severity: SEV1 (paged users) | SEV2 (degraded) | SEV3 (internal only)
- Customer impact: <one sentence>
- Root cause: <one sentence>
- Trigger: <what change, deploy, or external event caused it>
- Why we missed it before: <which detection / test gap>
- Mitigation: <the smallest thing that fixed it>
- Prevention: <the test, alert, or doc that would catch this next time>
- Action items:
  - [ ] <concrete ticket link>
```

Drop the completed template into `docs/postmortems/YYYY-MM-DD-<slug>.md` and
link it from the issue that tracked the incident.