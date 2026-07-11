# YIL-4 — Authentication

This document describes the auth system we shipped for the YIL marketplace
and the trade-offs behind the choices. **Read this before changing
anything in `src/lib/auth/` or `src/app/api/auth/`.**

## What shipped

1. **Email + password sign-up** — `POST /api/auth/register`.
2. **Email + password sign-in** — `POST /api/auth/login`.
3. **Magic-link sign-in** — `POST /api/auth/magic/request` + `POST /api/auth/magic/verify`.
4. **Sign-out** — `POST /api/auth/logout`.
5. **`/api/me`** — the canonical "who am I?" probe for frontend use.

All session management flows through one cookie, one library, one DB
table. There is no parallel "remember me" token, no per-device flag, and
no separate admin login.

## Stack

| Concern             | Library / approach                        | Why                                                                      |
| ------------------- | ----------------------------------------- | ------------------------------------------------------------------------ |
| HTTP framework      | Next.js 14 (App Router), `runtime=nodejs` | One process owns the API. Runtime is `nodejs` for `crypto.randomBytes`. |
| Database            | Postgres 18 via Drizzle ORM               | Already chosen by the bootstrap (YIL-3).                                 |
| Password hashing    | `bcryptjs`                                | Pure JS, no native build, deploys anywhere. Cost 12 (OWASP 2024).       |
| Session token sign  | `jose` (HS256)                            | Modern, edge-friendly, audited.                                          |
| Cookie library      | Native `cookies()` from `next/server`     | No extra dep.                                                            |
| Input validation    | `zod`                                     | Already in the bootstrap; one schema home.                               |
| Email transport     | Stubbed `sendMagicLinkEmail`              | Swap for an SDK later; routes do not import an SDK.                      |
| Rate limiting       | Per-route in-memory counter               | Swap for Redis later; routes do not import the store.                   |

## Data model

Three tables added in `db/migrations/0002_auth.sql`:

### `users` (extended)
Adds `email`, `password_hash`, leaves the existing columns alone. `email`
is the auth subject and is unique. `password_hash` is NULL when the
account was created magic-link-only and never set a password.

### `auth_sessions`
Server-side session records. The cookie is a signed JWT whose payload is
`{ sid, sub, exp, iat }`. The DB row is the source of truth: `revoked_at`
or `expires_at` invalidates the session immediately, with no need to wait
for the JWT to expire. The cookie value is `sha256`-indexed by the DB so we
look up directly from the cookie without an extra column.

### `magic_link_tokens`
Single-use, short-lived (15 min) tokens mailed to users for passwordless
sign-in and email verification. The raw token is mailed; only its
`sha256` hash is stored. A `purpose` column ties a token to a single flow
(`signin` or `verify_email`).

## Session strategy — choices explained

### Why DB-backed sessions, not stateless JWTs

A pure stateless JWT (no server-side record) has two sharp edges:

- **Revocation is impossible without server state.** If a user clicks
  "log out everywhere" or we suspect token theft, we cannot kill the
  token. The only options are a denylist (i.e. server state) or "wait 14
  days."
- **Compromised signing key = all-time compromise.** Rotating a key
  invalidates every session in flight. With server state, we can re-sign
  sessions on the next verify and users stay logged in.

We compromise: a JWT for the cookie (so middleware can validate signature
in O(1)) plus a DB row (so revocation is one `UPDATE`). The DB hit is on
the hot read path of `/api/me` and any protected endpoint, and the query
is indexed — cheap.

### Why HttpOnly + SameSite=Lax cookies

- `HttpOnly` blocks page-side JS from reading the cookie, neutralising
  the most common XSS data-exfiltration vector.
- `SameSite=Lax` blocks third-party `POST`s from carrying the cookie,
  which covers most CSRF without breaking top-level navigation. We
  additionally require same-origin for state-changing requests.
- `Secure` is on in production (`NODE_ENV=production`) and off in dev so
  the cookie actually reaches `http://localhost:3000`.

### Why HS256, not RS256

We have one deploy target. We never need to verify a session token from
a service that does not hold the signing key. HS256 keeps deploy
ergonomics as one env var. If we add a second service that needs to
verify sessions without holding the signing secret, we will move to
RS256 with a JWKS endpoint. Documenting this here so the next engineer
does not have to re-derive it.

## Magic-link choices

- **Always 202 from `/request`** — even for unknown addresses. The
  endpoint cannot be used to enumerate which addresses are registered.
- **15-minute TTL.** Long enough for a distracted user; short enough
  that a leaked email does not become a long-lived bypass.
- **Single-use.** The verify route is an atomic `UPDATE … WHERE
  consumed_at IS NULL`, so two parallel clicks sign in exactly once.
- **Purpose-bound.** A `signin` token cannot be replayed as
  `verify_email`. Defence-in-depth: the worst case (token theft) is a
  sign-in, not an arbitrary state change.
- **Auto sign-up.** First time we see an email through the magic link, we
  create a `users` row, mark it `email_verified = true`, and set the
  cookie. The user does not need a separate "register" step.

## Password policy

- Minimum 10 characters, must contain at least one letter and one digit.
- We deliberately do **not** force special characters. Length buys more
  entropy than character-class variety at the cost UX sees.
- Hashed at cost factor 12. Verified via constant-time comparison
  (handled by `bcrypt.compare`).
- On failed login we still run a bcrypt verify against a fixed dummy
  hash so "unknown email" and "wrong password" responses have comparable
  timing.

## Email transport (TODO)

`src/lib/auth/email.ts` currently logs the link in non-production
console output and emits a structured log event in production. We need
to wire a transactional provider (Postmark or Resend) before launch.
The interface is `sendMagicLinkEmail({ to, url, expiresAt })` — one
swap and every route is upgraded.

## Endpoints

| Method | Path                          | Body                                 | Success                               | Failure                                                              |
| ------ | ----------------------------- | ------------------------------------ | ------------------------------------- | -------------------------------------------------------------------- |
| POST   | `/api/auth/register`          | `{ email, password, handle?, displayName? }` | 201 + `Set-Cookie yil_session=…` | 400 invalid_request, 409 `email_taken` / `handle_taken`              |
| POST   | `/api/auth/login`             | `{ email, password }`                | 200 + cookie                          | 401 `invalid_credentials`                                            |
| POST   | `/api/auth/logout`            | —                                    | 204 + cookie cleared                  | —                                                                    |
| POST   | `/api/auth/magic/request`     | `{ email }`                          | 202 (always — no enumeration)         | 400 invalid_request                                                  |
| POST   | `/api/auth/magic/verify`      | `{ token }`                          | 200 + cookie                          | 400 `invalid_or_expired_token`                                       |
| GET    | `/api/me`                     | —                                    | 200 `{ user: {...} }`                 | 401 `unauthenticated`                                                |

The `user` payload intentionally omits `password_hash`, `emailVerified`
is exposed so the frontend can prompt for verification, `role` so a UI
can show admin affordances when appropriate.

## Testing

- `src/lib/auth/password.test.ts` — round-trip + wrong password + bad input.
- `src/lib/auth/validate.test.ts` — Zod schemas accept / reject the right cases.
- `src/lib/auth/crypto.test.ts` — tokens, hashes, constant-time equality.

Integration tests (auth + DB end-to-end) are intentionally not part of
this issue. Adding them requires a test database and migrations on the
test runner; that is its own work item once CI is wired up.

## Rollout notes (for production migrations)

The migration `db/migrations/0002_auth.sql` assumes a fresh database:
there are no pre-existing users, so `ALTER TABLE … ADD COLUMN email NOT
NULL` is safe. For a database that already has users, backfill `email`
from your identity store first, then add the NOT NULL constraint.

## What's intentionally NOT in this issue

- OAuth (Google, GitHub, Apple). Coming in a later iteration. The schema
  leaves room: we can add an `identity_providers(user_id, provider,
  external_id)` table without touching users.
- Multi-factor auth. Same answer.
- "Remember me" long-lived sessions. The 14-day TTL is our single
  tier; if we need >30 days we add a separate cookie and a different
  DB column.
- Password reset flow. Trivial extension — issue a magic link with
  `purpose = "reset_password"`, prompt for a new password. Tracked
  separately.
- Rate limiting at the edge. We're behind infrastructure that does this
  in prod; the per-route in-memory limiter is for tests only.
