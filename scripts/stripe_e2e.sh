#!/usr/bin/env bash
#
# YIL-9 — Stripe end-to-end smoke test (test mode only).
#
# Exercises the full buyer → capture → refund flow against a running local
# app + a Stripe-CLI webhook listener. Idempotent and safe to re-run.
#
# Prerequisites:
#   1. STRIPE_SECRET_KEY set in env (must start with sk_test_).
#   2. STRIPE_WEBHOOK_SECRET set (output of `stripe listen --forward-to ...`).
#   3. The app running on http://localhost:3000 with DATABASE_URL pointing
#      at a database that has had migrations applied (incl. 0003_payment_intents.sql).
#   4. A buyer_id and seller_id that exist in the users table, and a
#      listing owned by the seller.
#   5. `stripe` CLI installed and logged in to the test-mode account.
#   6. A `stripe listen --forward-to localhost:3000/api/webhooks/stripe`
#      running in another terminal so webhooks reach the app.
#
# Exits 0 on full success, non-zero on any step. Designed to be the CI gate
# that proves YIL-9 is wired end-to-end.

set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
USER_ID_HEADER="${USER_ID_HEADER:-x-user-id}"
ROLE_HEADER="${ROLE_HEADER:-x-user-role}"

if [[ -z "${STRIPE_SECRET_KEY:-}" ]]; then
  echo "FAIL: STRIPE_SECRET_KEY is not set" >&2
  exit 1
fi
if [[ "${STRIPE_SECRET_KEY}" != sk_test_* ]]; then
  echo "FAIL: STRIPE_SECRET_KEY must be a test-mode key (sk_test_...)" >&2
  exit 1
fi
if ! command -v stripe >/dev/null 2>&1; then
  echo "FAIL: stripe CLI not installed; install with 'brew install stripe/stripe-cli/stripe'" >&2
  exit 1
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "FAIL: jq not installed" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
log() { printf '\n\033[1;34m▶ %s\033[0m\n' "$*"; }
fail() { printf '\n\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
ok()   { printf '\033[1;32m✓ %s\033[0m\n' "$*"; }

# ---------------------------------------------------------------------------
# 0. Smoke — the app is alive.
# ---------------------------------------------------------------------------
log "0/6 health check"
HEALTH=$(curl -fsS "$BASE_URL/api/health")
DB_OK=$(echo "$HEALTH" | jq -r '.db.ok')
[[ "$DB_OK" == "true" ]] || fail "health: db.ok=$DB_OK"
ok "health OK"

# ---------------------------------------------------------------------------
# 1. Create an order via psql (the simplest way; the orders API is in YIL-14).
# ---------------------------------------------------------------------------
log "1/6 create an order in 'initiated' state"
read -r BUYER_ID SELLER_ID LISTING_ID < <(DATABASE_URL="$DATABASE_URL" psql -tA -c "
  with u as (
    select id from users where role = 'buyer'  and deleted_at is null order by created_at limit 1
  ), s as (
    select id from users where role = 'seller' and deleted_at is null order by created_at limit 1
  ), l as (
    select id from listings where status = 'published' and deleted_at is null order by created_at limit 1
  )
  select (select id from u), (select id from s), (select id from l);
" 2>/dev/null) || fail "could not seed buyer/seller/listing — have you created test fixtures?"

if [[ -z "$BUYER_ID" || -z "$SELLER_ID" || -z "$LISTING_ID" ]]; then
  fail "missing buyer/seller/listing rows; seed the DB first"
fi

ORDER_ID=$(DATABASE_URL="$DATABASE_URL" psql -tA -c "
  insert into orders (listing_id, buyer_id, seller_id, state, amount_minor, currency)
  values ('$LISTING_ID', '$BUYER_ID', '$SELLER_ID', 'initiated', 2500, 'USD')
  returning id;
" 2>/dev/null | tr -d '[:space:]')
[[ -n "$ORDER_ID" ]] || fail "order creation failed"
ok "order $ORDER_ID created"

# ---------------------------------------------------------------------------
# 2. Create a PaymentIntent.
# ---------------------------------------------------------------------------
log "2/6 create a PaymentIntent"
INTENT_RES=$(curl -fsS -X POST "$BASE_URL/api/checkout/intent" \
  -H "content-type: application/json" \
  -H "$USER_ID_HEADER: $BUYER_ID" \
  -H "$ROLE_HEADER: buyer" \
  -d "{\"order_id\":\"$ORDER_ID\"}")
TX_ID=$(echo "$INTENT_RES" | jq -r '.transaction_id')
PI_ID=$(echo "$INTENT_RES" | jq -r '.stripe_payment_intent_id')
[[ -n "$TX_ID" && "$TX_ID" != "null" ]] || fail "no transaction_id in $INTENT_RES"
[[ "$PI_ID" == pi_* ]] || fail "no stripe pi_… id in $INTENT_RES"
ok "tx=$TX_ID pi=$PI_ID"

# ---------------------------------------------------------------------------
# 3. Confirm the PaymentIntent via stripe CLI (uses Stripe test card).
# ---------------------------------------------------------------------------
log "3/6 confirm the PaymentIntent with a test card"
stripe payment_intents confirm "$PI_ID" \
  --payment-method pm_card_visa \
  --return-url "http://localhost:3000/checkout/return?tx=$TX_ID" >/dev/null \
  || fail "stripe payment_intents confirm failed"
ok "intent confirmed on Stripe"

# ---------------------------------------------------------------------------
# 4. Wait for the webhook to land + reconcile.
# ---------------------------------------------------------------------------
log "4/6 wait for payment_intent.succeeded webhook"
DEADLINE=$(( $(date +%s) + 30 ))
STATUS=""
while [[ $(date +%s) -lt $DEADLINE ]]; do
  STATUS=$(curl -fsS -H "$USER_ID_HEADER: $BUYER_ID" \
    "$BASE_URL/api/transactions/$TX_ID" | jq -r '.state')
  [[ "$STATUS" == "captured" ]] && break
  sleep 0.5
done
[[ "$STATUS" == "captured" ]] || fail "tx not captured after 30s (last status=$STATUS)"
ok "tx captured"

# ---------------------------------------------------------------------------
# 5. Full refund.
# ---------------------------------------------------------------------------
log "5/6 issue a full refund"
REFUND_RES=$(curl -fsS -X POST "$BASE_URL/api/refunds" \
  -H "content-type: application/json" \
  -H "$USER_ID_HEADER: $SELLER_ID" \
  -H "$ROLE_HEADER: seller" \
  -d "{\"transaction_id\":\"$TX_ID\",\"reason\":\"requested_by_customer\"}")
REFUND_ID=$(echo "$REFUND_RES" | jq -r '.refund_id')
[[ -n "$REFUND_ID" && "$REFUND_ID" != "null" ]] || fail "no refund_id in $REFUND_RES"
ok "refund $REFUND_ID issued"

# ---------------------------------------------------------------------------
# 6. Wait for the charge.refunded webhook + reconciled state.
# ---------------------------------------------------------------------------
log "6/6 wait for charge.refunded webhook"
DEADLINE=$(( $(date +%s) + 30 ))
STATUS=""
while [[ $(date +%s) -lt $DEADLINE ]]; do
  STATUS=$(curl -fsS -H "$USER_ID_HEADER: $BUYER_ID" \
    "$BASE_URL/api/transactions/$TX_ID" | jq -r '.state')
  [[ "$STATUS" == "refunded" ]] && break
  sleep 0.5
done
[[ "$STATUS" == "refunded" ]] || fail "tx not refunded after 30s (last status=$STATUS)"
ok "tx refunded"

printf '\n\033[1;32m✅ YIL-9 end-to-end PASSED\033[0m\n'
printf '   order=%s\n   tx=%s\n   pi=%s\n   refund=%s\n' "$ORDER_ID" "$TX_ID" "$PI_ID" "$REFUND_ID"