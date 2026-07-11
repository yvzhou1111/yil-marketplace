# YIL Marketplace

Bootstrap of the YIL marketplace app (Week 1.1 — YIL-3).

## Stack

- **Next.js 14** (App Router, TypeScript, standalone output)
- **PostgreSQL 18** (via `postgres:18-alpine`)
- **Drizzle ORM** + `pg` for typed schema and migrations
- **Vitest** for unit tests
- **GitHub Actions** for CI
- **Docker / docker-compose** for the local preview environment

## Local development

```bash
cp .env.example .env
docker compose up -d postgres
npm install
npm run db:generate      # generate SQL migration from src/db/schema.ts
npm run db:migrate       # apply migrations to the local DB
npm run dev              # http://localhost:3000
```

The homepage hits Postgres and the `/api/health` endpoint returns
`200` only when both the app and the database are reachable.

## Tests

```bash
npm run lint
npm run typecheck
npm test
```

## Preview environment

The **preview environment is a `docker compose` stack** that mirrors what
runs in production: Postgres + the Next.js standalone build.

To bring it up locally:

```bash
docker compose up --build
curl http://localhost:3000/api/health
curl http://localhost:3000/
```

In CI, the same flow runs as the `preview` job: a Postgres service is
spun up, migrations and seed run against it, the app is built and
started, and both `/api/health` and the homepage are exercised.

This is the **hello-world PR deploy path**: any PR that lands on `main`
goes through lint → typecheck → test → build → preview smoke test.

## Deploy pipeline overview

```
PR opened
  ├─► GitHub Actions: lint + typecheck + test       (fast feedback)
  ├─► GitHub Actions: build (Next.js standalone)   (artifacts)
  └─► GitHub Actions: preview (Postgres + smoke)    (end-to-end check)

PR merged to main
  └─► (future) Push Docker image to ghcr.io
  └─► (future) Deploy to production host / Fly.io / Render
```

This heartbeat establishes the **PR preview pipeline end-to-end**. The
production deploy target is intentionally left as a follow-up — pick a
host (Fly.io is the current shortlist) and add a `deploy.yml` workflow.

## Repo layout

```
.
├── .github/workflows/ci.yml      lint, typecheck, test, build, preview
├── src/
│   ├── app/                      Next.js App Router
│   │   ├── api/health/route.ts   GET /api/health
│   │   ├── api/checkout/intent/  POST create PaymentIntent          (YIL-9)
│   │   ├── api/webhooks/stripe/  POST receive Stripe events         (YIL-9)
│   │   ├── api/refunds/          POST issue a refund                (YIL-9)
│   │   ├── api/transactions/[id] GET  read transaction state         (YIL-9)
│   │   ├── globals.css
│   │   ├── layout.tsx
│   │   └── page.tsx              hello-world homepage
│   ├── db/
│   │   ├── client.ts             Drizzle + pg pool singleton
│   │   └── schema.ts             `listings` + orders + reviews + payment_intents
│   ├── payments/                 Stripe integration (YIL-9, pure state machine + Drizzle layer)
│   │   ├── state.ts              PaymentIntentRecord state machine
│   │   ├── idempotency.ts        Stripe Idempotency-Key + webhook dedupe
│   │   ├── intents.ts            createIntentForOrder (Stripe SDK call)
│   │   ├── webhooks.ts           verify + dispatch + apply
│   │   ├── refunds.ts            createRefund
│   │   ├── stripe.ts             singleton client + live-key guard
│   │   └── db.ts                 Drizzle adapters (liveWebhookStore, insertPendingIntent, …)
│   └── lib/
│       ├── hello.ts              pure helper (unit-tested)
│       └── hello.test.ts
├── scripts/
│   ├── migrate.ts                apply migrations at boot
│   ├── seed.ts                   seed a hello-world listing
│   └── stripe_e2e.sh             YIL-9 end-to-end smoke (test mode)
├── docs/
│   └── payments/STRIPE.md        YIL-9 design + ops notes
├── db/migrations/
│   ├── 0000_bootstrap_extensions.sql
│   ├── 0001_search_index.sql
│   ├── 0002_search_index.sql …   (YIL-8)
│   └── 0003_payment_intents.sql  YIL-9 payment_intents + refunds + stripe_events_seen
├── docker-compose.yml            postgres + app
├── Dockerfile                    multi-stage, standalone output
├── drizzle.config.ts
└── package.json
```

## Why this stack

- **Next.js App Router** — single deployable for UI + server routes,
  zero ceremony for SSR streaming and edge-friendly features later.
- **Drizzle** — typed queries, plain SQL migrations, no runtime overhead.
- **Vitest** — fast, ESM-native, drops into the same TS path aliases.
- **Docker for preview** — preview == what runs in production; no
  drift between "works on my machine" and "works on Fly/Render".

## Hello-world verification

The minimum end-to-end check:

1. Open a PR against `main`.
2. CI runs lint, typecheck, test, build, and the preview job.
3. Preview job boots Postgres, migrates, seeds, starts the app,
   asserts `/api/health` returns 200 and the homepage contains
   `"Hello, marketplace!"`.

If all three of those are green, the deploy pipeline is healthy.

## Payments (YIL-9)

Stripe in test mode. Full design + ops notes in
[`docs/payments/STRIPE.md`](docs/payments/STRIPE.md). The end-to-end smoke
test is `scripts/stripe_e2e.sh` — it requires
`STRIPE_SECRET_KEY` (test) and a `stripe listen` session forwarding
webhooks to `localhost:3000/api/webhooks/stripe`.