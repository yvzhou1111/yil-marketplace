# YIL Admin Console (YIL-11)

A minimal-but-functional internal admin console for the YIL marketplace. Three
pages, hand-rolled in Next.js so it's small enough to read end-to-end:

| Route               | What it does                                                                 |
|---------------------|------------------------------------------------------------------------------|
| `/admin/listings`   | Moderation queue — approve, reject, undo, or remove listings.                |
| `/admin/users`      | User lookup — search by email/name/id, filter by role, see listing counts.    |
| `/admin/metrics`    | Dashboard — users, listings, approval rate, gross catalog value.              |

All state changes go through `src/lib/moderation.ts`, which logs every action
to `admin.moderation_events` and refreshes `admin.metrics_snapshot` afterwards.

## Why this stack

- **Next.js 14 App Router + Postgres**: zero ceremony, server components give
  us the SQL query right next to the JSX, no separate API server.
- **No design system**: this is internal, not customer-facing. A single
  `globals.css` keeps the contrast acceptable and that's enough.
- **Hand-rolled auth shim**: real auth is owned by YIL-4. Until that lands we
  trust an `x-admin-email` header; production deployment must replace
  `requireAdmin()` with the shared middleware.

## Running it locally

```bash
# 1. Boot a Postgres (any 14+ works) and put the URL in .env
cp .env.example .env
echo "DATABASE_URL=postgres://postgres:postgres@localhost:5432/yil_admin" > .env

# 2. Apply schema (creates tables if missing, seeds demo data)
npm install
npm run db:init

# 3. Run the dev server on :3001 so it doesn't fight the public app
npm run dev
# open http://localhost:3001/admin/listings
```

The seed data gives you one pending queue to triage, two approved listings, one
rejected listing, and one obvious spam listing — enough to exercise every
button on the moderation page.

## Verification

```bash
# Smoke-test the moderation flow end to end
bash scripts/smoke.sh
```

The smoke test boots the Next.js server, walks an approval + rejection + undo
round-trip against the running app, and exits non-zero if anything diverges
from the expected state. It is deliberately shell + curl to keep the admin
console's verification independent of its own server runtime.

## What this does NOT include

- Real authentication (placeholder header auth only).
- Bulk moderation tools (one-at-a-time buttons).
- Search via Postgres trigram / FTS — `ilike` is enough for the soft launch
  volume and avoids a Postgres extension dependency.
- A web UI for editing listings — that's the seller app's job, not ours.

These are intentional cuts. They are tracked in `docs/follow-ups.md` so the
person picking up the next iteration of the admin console knows what was
deferred and why.

## File layout

```
admin-console/
├── README.md
├── package.json
├── tsconfig.json
├── sql/schema.sql         — tables, view, snapshot, seed data
├── scripts/smoke.sh       — end-to-end moderation verification
├── docs/follow-ups.md     — deferred items with rationale
└── src/
    ├── app/
    │   ├── layout.tsx
    │   ├── page.tsx                     — redirects to /admin/listings
    │   ├── globals.css
    │   ├── admin/
    │   │   ├── listings/page.tsx
    │   │   ├── users/page.tsx
    │   │   └── metrics/page.tsx
    │   └── api/
    │       ├── listings/[id]/{approve,reject}/route.ts
    │       └── users/lookup/route.ts
    └── lib/
        ├── db.ts          — pg pool + requireAdmin shim
        └── moderation.ts  — state machine, audit log, snapshot refresh
```