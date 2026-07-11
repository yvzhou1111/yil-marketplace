# YIL-9 — Stripe payments

This document describes how the marketplace integrates with Stripe in test
mode. The corresponding issue is **YIL-9 (Week 3.2: Payments integration)**.

## TL;DR

- Code lives under `src/payments/`.
- API surface: `POST /api/checkout/intent`, `POST /api/webhooks/stripe`,
  `POST /api/refunds`, `GET /api/transactions/[id]`.
- Schema: `payment_intents`, `refunds`, `stripe_events_seen`
  (see `db/migrations/0003_payment_intents.sql` and
  `src/db/schema.ts`).
- End-to-end smoke test: `scripts/stripe_e2e.sh`.
- Test mode only — `sk_live_…` keys are refused at boot.

## Endpoints

### `POST /api/checkout/intent`

Creates a Stripe PaymentIntent for an order. The body is
`{ order_id, buyer_email? }`. Auth is via YIL-4 (until then we accept
`x-user-id` for local exercising). Returns:

```json
{
  "transaction_id": "<local UUID>",
  "stripe_payment_intent_id": "pi_…",
  "client_secret": "pi_…_secret_…"
}
```

Idempotent on `order_id` — retrying with the same order returns the same
PaymentIntent.

### `POST /api/webhooks/stripe`

Receives events from Stripe. Verifies the `Stripe-Signature` header against
`STRIPE_WEBHOOK_SECRET`. Idempotent on `event.id` (we dedupe in
`stripe_events_seen`). Always returns 2xx unless the signature is invalid
(400, no retry).

Events we handle:

| Event | Local effect |
|-------|--------------|
| `payment_intent.succeeded` | `payment_intents.state = captured`, `orders.state = paid` |
| `payment_intent.payment_failed` | `payment_intents.state = failed` |
| `payment_intent.canceled` | `payment_intents.state = canceled`, `orders.state = cancelled` |
| `charge.refunded` | `payment_intents.state = refunded` (or `partially_refunded`), `refunded_amount_cents` synced to Stripe's view |
| `charge.dispute.created` | `payment_intents.state = disputed`, `orders.state = disputed` |

### `POST /api/refunds`

Body: `{ transaction_id, amount_cents?, reason }`. Auth: seller of the
listing, or admin. `reason` must be one of `duplicate`,
`requested_by_customer`, `fraudulent` (admin-only).

### `GET /api/transactions/[id]`

Returns the current local row. Auth: buyer or seller on the underlying
order, or admin.

## State machine

```
     pending ──► authorized ──► captured ──► refunded (terminal)
        │            │             │    ╲
        │            │             │     ╲► partially_refunded ──► refunded
        │            │             ╲► disputed
        ▼            ▼
     failed       failed
     canceled     canceled
```

Anything else is illegal. The DB has matching CHECK constraints and a
`payment_intents_refund_not_exceed` invariant that mirrors
`computeRefundTotals` in `state.ts`. The application state machine is
authoritative; the DB constraint is the last line of defense.

## Idempotency

- All Stripe API writes include an `Idempotency-Key` derived from the
  local row id: `pi-create:<uuid>` for intents, `re-create:<uuid>` for
  refunds.
- Inbound webhooks dedupe on Stripe's `event.id` (24h window). Replays
  return 200 with `{ status: "duplicate" }`.

## Out of scope (this issue)

- Stripe Connect / payouts (separate issue, YIL-15ish).
- Multi-currency — we ship USD only.
- Apple Pay / Google Pay wallet methods.
- Stripe Tax.
- Subscriptions.

## Local exercising (test mode)

```bash
# 1. Put test-mode keys in .env.local:
STRIPE_SECRET_KEY=sk_test_…
STRIPE_PUBLISHABLE_KEY=pk_test_…
# The webhook secret is per-`stripe listen` invocation; don't commit it.

# 2. Apply migrations:
npm run db:migrate

# 3. Start the app:
npm run dev

# 4. In a second terminal, forward webhooks:
stripe listen --forward-to localhost:3000/api/webhooks/stripe
# Copy the `whsec_…` it prints into STRIPE_WEBHOOK_SECRET, then restart the app.

# 5. Run the e2e smoke test:
bash scripts/stripe_e2e.sh
```

`stripe_e2e.sh` exits 0 only when the full buyer → capture → refund flow
is observed end-to-end. It is the CI gate for YIL-9.

## Why this isn't done in this heartbeat

The end-to-end `stripe_e2e.sh` requires:

1. A deployed app reachable on `http://localhost:3000`.
2. Stripe test keys provisioned (CEO action — YIL-1 unblocks).
3. A `stripe listen` session actively forwarding webhooks.

(1) requires YIL-3 (deploy pipeline) to be wired up to a host, which is
in flight. (2) needs the CEO to provision keys (action item, see
Paperclip issue comments). (3) is per-developer-machine.

What landed in this heartbeat:

- Pure state machine + idempotency + types (no I/O).
- Stripe SDK wrapper with live-key guard.
- Drizzle schema for `payment_intents`, `refunds`, `stripe_events_seen`
  + matching migration `0003_payment_intents.sql`.
- API routes (intent / webhook / refund / read).
- Vitest coverage for state, idempotency, intents (mocked Stripe),
  refunds (mocked Stripe), webhooks (mocked `constructEvent`).
- 48 tests, all passing; full repo: 282/282.
- `scripts/stripe_e2e.sh` ready to run as soon as keys arrive.

When the CEO provisions `STRIPE_SECRET_KEY` and YIL-3 ships the deploy
pipeline, the next heartbeat should be able to run `stripe_e2e.sh`
end-to-end with no code changes.