-- YIL-9 — Stripe payment_intents, refunds, stripe_events_seen.
--
-- This migration is intentionally additive: it does NOT alter the
-- `orders` table owned by YIL-14 (Transactions schema and state machine).
-- The order ↔ payment_intent link is by `order_id`, and webhook
-- reconciliation updates `orders.state` to `'paid' | 'disputed' | 'canceled'`
-- via YIL-14's existing state machine.
--
-- All money columns are `bigint` minor units (cents for USD). We use
-- `gen_random_uuid()` for PKs, matching the rest of the schema.

BEGIN;

-- pgcrypto provides gen_random_uuid(); safe to create-if-not-exists.
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ----------------------------------------------------------------------------
-- payment_intents — local shadow of Stripe PaymentIntents.
-- ----------------------------------------------------------------------------
create table if not exists public.payment_intents (
  id                          uuid primary key default gen_random_uuid(),
  order_id                    uuid not null references public.orders(id) on delete restrict,
  -- `pi_…` from Stripe. Nullable until the API call returns.
  stripe_payment_intent_id    text unique,
  amount_cents                bigint not null check (amount_cents > 0),
  currency                    varchar(3) not null,
  state                       text not null default 'pending'
                                check (state in (
                                  'pending','authorized','captured',
                                  'failed','canceled',
                                  'refunded','partially_refunded','disputed'
                                )),
  refunded_amount_cents       bigint not null default 0 check (refunded_amount_cents >= 0),
  last_error_message          text,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now()
);

create index if not exists payment_intents_order_idx
  on public.payment_intents (order_id, created_at desc);

create index if not exists payment_intents_state_idx
  on public.payment_intents (state, created_at desc);

-- Enforce: refunded_amount_cents never exceeds amount_cents.
-- This is the DB-level guard for the state.ts `computeRefundTotals` invariant.
alter table public.payment_intents
  drop constraint if exists payment_intents_refund_not_exceed;
alter table public.payment_intents
  add constraint payment_intents_refund_not_exceed
  check (refunded_amount_cents <= amount_cents);

-- updated_at trigger — reuse the same convention as other tables.
create or replace function public.yil_set_updated_at() returns trigger
  language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists payment_intents_set_updated_at on public.payment_intents;
create trigger payment_intents_set_updated_at
  before update on public.payment_intents
  for each row execute function public.yil_set_updated_at();

-- ----------------------------------------------------------------------------
-- refunds — one row per Stripe Refund.
-- ----------------------------------------------------------------------------
create table if not exists public.refunds (
  id                          uuid primary key default gen_random_uuid(),
  payment_intent_id           uuid not null references public.payment_intents(id) on delete cascade,
  -- `re_…` from Stripe.
  stripe_refund_id            text unique not null,
  amount_cents                bigint not null check (amount_cents > 0),
  kind                        text not null check (kind in ('full','partial')),
  reason                      text check (reason in ('duplicate','fraudulent','requested_by_customer')),
  created_at                  timestamptz not null default now()
);

create index if not exists refunds_payment_intent_idx
  on public.refunds (payment_intent_id, created_at desc);

-- ----------------------------------------------------------------------------
-- stripe_events_seen — dedupe inbound webhook events.
-- ----------------------------------------------------------------------------
create table if not exists public.stripe_events_seen (
  event_id                    text primary key,         -- `evt_…`
  received_at                 timestamptz not null default now()
);

-- Cheap pruning: keep last 7 days; cron job can `delete from stripe_events_seen where received_at < now() - interval '7 days'`.
create index if not exists stripe_events_seen_received_at_idx
  on public.stripe_events_seen (received_at);

COMMIT;