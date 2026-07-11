# Stripe Payments Integration — Design & Implementation Spec (YIL-9)

**Issue:** YIL-9 (Week 3.2: Payments integration — Stripe)
**Author:** founding-engineer
**Status:** Spec ready, blocked on prerequisites
**Target:** test mode end-to-end, full buyer + seller flow verified

---

## 1. Goal

Wire the marketplace's order/transaction pipeline to Stripe in test mode so that:

1. **Buyer flow** — buyer can pay for a listing and we capture funds server-side, idempotently, and persist a `Transaction` record that transitions to `captured`.
2. **Seller flow** — once captured, the seller's order balance is credited toward payout (payout path is out of scope for this issue; YIL-12 hooks observability, YIL-15 ships the soft launch).
3. **Refund path** — both full and partial refunds are supported; `Transaction.status` updates accordingly and Stripe `charge.refunded` webhook reconciles state.
4. **Webhook reliability** — every payment-state change is reconciled via webhook (the success URL is convenience only, never the source of truth).
5. **End-to-end verification** — a single shell script drives the full buyer → capture → refund flow using Stripe test cards and `stripe listen` webhook forwarding; exit code is the gate.

## 2. Preconditions (current blockers — heartbeat 2026-07-11)

| ID | Title | Why it blocks |
|----|-------|---------------|
| YIL-3 | Bootstrap repo and deploy pipeline | No app exists to host `/api/webhooks/stripe` or checkout endpoints. |
| YIL-5 | Define core data model | No `Order`, `Listing`, `User` schema to anchor `Transaction` against. |
| YIL-14 | Week 3.1: Transactions schema and state machine | Direct predecessor; `Transaction` table + state machine must exist before webhook handlers can update it. |
| YIL-1 (parent) | Hire your first engineer and create a hiring plan | CEO-side unblock: provision Stripe test keys. |

**Concrete unblock actions (named owners):**

- **founding-engineer** (me): land YIL-3 → YIL-5 → YIL-14 in that order on a heartbeat cycle, then YIL-9 becomes buildable in the next cycle.
- **CEO / YIL-1 (yilixgo)**: provision `STRIPE_SECRET_KEY` (test mode, `sk_test_…`), `STRIPE_PUBLISHABLE_KEY` (`pk_test_…`), and `STRIPE_WEBHOOK_SECRET` (from `stripe listen` output). Drop into `instances/default/.env` or secret store.

## 3. Architecture

```
┌──────────┐    POST /api/checkout/intent    ┌────────────────────────┐
│  Buyer   ├────────────────────────────────▶│ Server (createPI)      │
│ (client) │                                 │  - validates order     │
│          │◀──────── client_secret ─────────┤  - creates PI (idemp)  │
│          │                                 │  - persists tx(pnd)    │
│          │  stripe.confirmCardPayment(...) │                        │
│          ├──────────────── Stripe API ─────▶│                        │
└──────────┘                                 └────────────────────────┘
                                                       ▲
                                                       │ webhook events
                                                       │ payment_intent.succeeded
                                                       │ payment_intent.payment_failed
                                                       │ charge.refunded
                                                       │ charge.dispute.created
                                                ┌──────┴──────┐
                                                │   Stripe     │
                                                └──────────────┘
                                                       │
                                                       ▼
                                          ┌────────────────────────┐
                                          │ /api/webhooks/stripe   │
                                          │  - verify signature   │
                                          │  - find tx by PI id   │
                                          │  - transition state   │
                                          │  - emit observability │
                                          └────────────────────────┘
```

### 3.1 Endpoints

| Method | Path | Purpose | Auth |
|--------|------|---------|------|
| POST | `/api/checkout/intent` | Create PaymentIntent for an order | buyer session |
| POST | `/api/webhooks/stripe` | Receive Stripe events (raw body, signature header) | Stripe signature |
| POST | `/api/refunds` | Issue full or partial refund | seller/admin session |
| GET | `/api/transactions/:id` | Read transaction state | buyer/seller/admin |

### 3.2 Webhook events to handle

| Event | Transaction transition | Side effects |
|-------|------------------------|--------------|
| `payment_intent.succeeded` | `pending → captured` | Mark order `paid`, notify seller |
| `payment_intent.payment_failed` | `pending → failed` | Mark order `payment_failed`, surface reason |
| `charge.refunded` | `captured → refunded` (or `partially_refunded` for partial) | Decrement seller balance, notify both parties |
| `charge.dispute.created` | `captured → disputed` | Freeze payout, alert on-call |
| `payment_intent.canceled` | `pending → canceled` | Release order hold |

### 3.3 Idempotency

Every Stripe write uses an `Idempotency-Key` derived from `transaction_id` (UUIDv7). The webhook handler dedupes incoming event IDs by storing the last 24h of `event.id` values in a `stripe_events_seen` table — replays must be no-ops, not errors.

## 4. Data contract (depends on YIL-5 / YIL-14)

```ts
// Sketches; final shapes land with YIL-14.
Transaction {
  id: uuid
  order_id: uuid
  stripe_payment_intent_id: string  // pi_…
  amount_cents: int
  currency: text  // 'usd' for v1
  status: 'pending' | 'authorized' | 'captured'
         | 'failed' | 'refunded' | 'partially_refunded'
         | 'disputed' | 'canceled'
  refunded_amount_cents: int  // 0 unless partial/full refund
  created_at, updated_at: timestamptz
}

StripeEventSeen {
  event_id: text  // primary key, Stripe evt_…
  received_at: timestamptz
}
```

## 5. Env contract

```bash
STRIPE_SECRET_KEY=sk_test_...        # server only
STRIPE_PUBLISHABLE_KEY=pk_test_...   # client
STRIPE_WEBHOOK_SECRET=whsec_...      # from `stripe listen`
STRIPE_API_VERSION=2024-06-20        # pin explicitly
```

## 6. Code layout (when repo exists)

```
src/payments/
  stripe.ts            # singleton client; pinned API version
  intents.ts           # createIntentForOrder(orderId) -> { id, client_secret }
  webhooks.ts          # handleEvent(req) — verify, dispatch, persist
  refunds.ts           # createRefund(txId, amountCents?) -> updated tx
  state.ts             # tx state transitions; throws on illegal moves
  idempotency.ts       # key derivation, dedupe table
test/payments/
  e2e.test.ts          # buyer → capture → refund
scripts/
  stripe_e2e.sh        # full end-to-end driver (used in CI)
```

## 7. End-to-end verification (the acceptance gate)

`scripts/stripe_e2e.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

# Prereq: stripe CLI logged in, webhooks forwarded via `stripe listen --forward-to localhost:3000/api/webhooks/stripe`
# Prereq: server running with STRIPE_SECRET_KEY set.

ORDER_ID=$(curl -fsS -X POST localhost:3000/api/checkout/intent \
  -H 'content-type: application/json' \
  -d '{"listing_id":"…","buyer_id":"…"}' | jq -r .transaction_id)

PI_ID=$(curl -fsS localhost:3000/api/transactions/$ORDER_ID | jq -r .stripe_payment_intent_id)

# Pay with Stripe test card via stripe CLI (or via Stripe.js in headless browser)
stripe payment_intents confirm $PI_ID \
  --payment-method pm_card_visa

# Wait for webhook to land
for i in $(seq 1 30); do
  status=$(curl -fsS localhost:3000/api/transactions/$ORDER_ID | jq -r .status)
  [[ "$status" == "captured" ]] && break
  sleep 0.5
done
[[ "$status" == "captured" ]] || { echo "FAIL: tx not captured ($status)"; exit 1; }

# Full refund
curl -fsS -X POST localhost:3000/api/refunds \
  -H 'content-type: application/json' \
  -d "{\"transaction_id\":\"$ORDER_ID\"}" >/dev/null

# Wait for refunded webhook
for i in $(seq 1 30); do
  status=$(curl -fsS localhost:3000/api/transactions/$ORDER_ID | jq -r .status)
  [[ "$status" == "refunded" ]] && break
  sleep 0.5
done
[[ "$status" == "refunded" ]] || { echo "FAIL: tx not refunded ($status)"; exit 1; }

echo "PASS: full buyer + refund flow verified in test mode"
```

## 8. Out of scope (this issue)

- Stripe Connect / seller payouts (separate issue once admin console lands)
- Multi-currency (single currency, USD, for v1)
- Apple Pay / Google Pay (browser wallet methods come after core flow passes)
- Tax (Stripe Tax integration is its own issue)
- Subscriptions (no recurring billing in marketplace v1)

## 9. Acceptance criteria

YIL-9 is **done** only when all of:

- [ ] Repo exists with `src/payments/*` modules implementing 3.1–3.3
- [ ] `stripe_e2e.sh` exits 0 on a clean machine
- [ ] Webhook handler is idempotent under `stripe events resend evt_…`
- [ ] At least one partial refund case is in the e2e test
- [ ] Stripe API version pinned in code (no implicit upgrades)
- [ ] Observability hooks (YIL-12) emit `payment.succeeded` / `payment.refunded` events
