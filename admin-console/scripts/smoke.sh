#!/usr/bin/env bash
# Smoke-test the admin console's moderation flow end-to-end against a running
# server. Requires:
#   - DATABASE_URL pointing at a DB with sql/schema.sql applied
#   - The admin console running on $BASE (default http://localhost:3001)
#
# Walks: list pending -> approve one -> reject one -> undo reject -> verify
# the moderation_events audit log got the right entries. Exits non-zero on
# the first divergence from expected state.

set -euo pipefail

BASE="${BASE:-http://localhost:3001}"
DB_URL="${DATABASE_URL:?DATABASE_URL must be set}"
PSQL="${PSQL:-psql}"

red()   { printf '\033[31m%s\033[0m\n' "$*" >&2; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }

assert_eq() {
  local name="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    green "  ✓ $name"
  else
    red "  ✗ $name (expected '$expected', got '$actual')"
    exit 1
  fi
}

echo "== smoke: health check =="
status=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/admin/listings")
assert_eq "/admin/listings returns 200" "200" "$status"

echo "== smoke: pending queue not empty =="
pending_count=$(
  $PSQL "$DB_URL" -tA -c \
    "select count(*) from public.listings where status='pending'"
)
if [ "$pending_count" -lt 2 ]; then
  red "  need at least 2 pending listings to smoke-test; got $pending_count"
  exit 1
fi
green "  ✓ pending count = $pending_count"

approve_id=$(
  $PSQL "$DB_URL" -tA -c \
    "select id from public.listings where status='pending' order by created_at asc limit 1"
)
reject_id=$(
  $PSQL "$DB_URL" -tA -c \
    "select id from public.listings where status='pending' order by created_at desc limit 1"
)

echo "== smoke: approve $approve_id =="
status=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/listings/$approve_id/approve")
assert_eq "approve POST returns 303" "303" "$status"
new_status=$(
  $PSQL "$DB_URL" -tA -c \
    "select status from public.listings where id='$approve_id'"
)
assert_eq "approved listing status" "approved" "$new_status"

echo "== smoke: reject $reject_id =="
status=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/listings/$reject_id/reject")
assert_eq "reject POST returns 303" "303" "$status"
new_status=$(
  $PSQL "$DB_URL" -tA -c \
    "select status from public.listings where id='$reject_id'"
)
assert_eq "rejected listing status" "rejected" "$new_status"

echo "== smoke: undo reject =="
status=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
  -H "Content-Type: application/json" -H "Accept: application/json" \
  -d '{"action":"unreject"}' \
  "$BASE/api/listings/$reject_id/reject")
assert_eq "unreject POST returns 200" "200" "$status"
new_status=$(
  $PSQL "$DB_URL" -tA -c \
    "select status from public.listings where id='$reject_id'"
)
assert_eq "undone-reject status" "pending" "$new_status"

echo "== smoke: metrics page renders =="
status=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/admin/metrics")
assert_eq "/admin/metrics returns 200" "200" "$status"

echo "== smoke: users lookup JSON works =="
count=$(
  curl -s "$BASE/api/users/lookup?q=buyer" | \
    python3 -c 'import json,sys; print(len(json.load(sys.stdin)["users"]))'
)
if [ "$count" -lt 1 ]; then
  red "  expected at least one buyer in users lookup; got $count"
  exit 1
fi
green "  ✓ buyer lookup returned $count rows"

echo "== smoke: audit log has expected events =="
approve_events=$(
  $PSQL "$DB_URL" -tA -c \
    "select count(*) from admin.moderation_events where listing_id='$approve_id' and action='approve'"
)
assert_eq "approve audit row" "1" "$approve_events"
reject_events=$(
  $PSQL "$DB_URL" -tA -c \
    "select count(*) from admin.moderation_events where listing_id='$reject_id' and action='reject'"
)
assert_eq "reject audit row" "1" "$reject_events"
unreject_events=$(
  $PSQL "$DB_URL" -tA -c \
    "select count(*) from admin.moderation_events where listing_id='$reject_id' and action='unreject'"
)
assert_eq "unreject audit row" "1" "$unreject_events"

green "== ALL SMOKE TESTS PASSED =="