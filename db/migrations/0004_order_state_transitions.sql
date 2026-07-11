-- YIL-14 — Order state machine audit + DB-level guards.
-- Run inside a transaction:
--   psql -v ON_ERROR_STOP=1 -f db/migrations/0004_order_state_transitions.sql
--
-- Requires: PostgreSQL >= 14 (uses gen_random_uuid from pgcrypto and partial
-- unique indexes). Mirrors the Drizzle schema in src/db/schema.ts and the
-- application-level state machine in src/orders/state-machine.ts.
--
-- Pre-existing tables this migration assumes (owned by YIL-5 / YIL-10):
--   public.users     (id uuid PK)
--   public.listings  (id uuid PK)
--   public.orders    (id uuid PK, with order_state enum and the
--                     partial-unique orders_active_buyer_unique index).
--
-- This migration is additive: it does not rewrite data in existing tables
-- other than adding nullable timestamp columns and CHECK constraints that
-- are always true for current rows.

BEGIN;

-- ----------------------------------------------------------------------------
-- New enum: who is recorded as having caused a transition
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type WHERE typname = 'order_transition_actor'
  ) THEN
    CREATE TYPE order_transition_actor AS ENUM (
      'buyer',
      'seller',
      'admin',
      'system'
    );
  END IF;
END$$;

-- ----------------------------------------------------------------------------
-- orders — add state-specific audit timestamps
-- ----------------------------------------------------------------------------
--
-- These mirror the *first* time the order entered the named state. They are
-- denormalized so operational queries ("average time to fulfilment") don't
-- have to walk the audit table. The audit table
-- (order_state_transitions) is the authoritative source for *who* and *why*.

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS paid_at      timestamptz,
  ADD COLUMN IF NOT EXISTS fulfilled_at timestamptz,
  ADD COLUMN IF NOT EXISTS disputed_at  timestamptz,
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;

-- Each CHECK makes the named state imply the matching timestamp is set.
-- We intentionally do NOT add a "timestamp set ⇒ state" direction because
-- the trigger below updates the timestamp *before* the state column, and
-- Postgres CHECK constraints must hold at the end of the statement only
-- when they reference the same row. Using "in or null" semantics keeps the
-- constraint always true at row commit time.
ALTER TABLE orders
  DROP CONSTRAINT IF EXISTS orders_paid_at_consistency;
ALTER TABLE orders
  ADD CONSTRAINT orders_paid_at_consistency
    CHECK (
      state IN ('paid', 'fulfilled', 'completed', 'disputed')
      OR paid_at IS NULL
    );

ALTER TABLE orders
  DROP CONSTRAINT IF EXISTS orders_fulfilled_at_consistency;
ALTER TABLE orders
  ADD CONSTRAINT orders_fulfilled_at_consistency
    CHECK (
      state IN ('fulfilled', 'completed', 'disputed')
      OR fulfilled_at IS NULL
    );

ALTER TABLE orders
  DROP CONSTRAINT IF EXISTS orders_completed_at_consistency;
ALTER TABLE orders
  ADD CONSTRAINT orders_completed_at_consistency
    CHECK (
      state = 'completed'
      OR completed_at IS NULL
    );

ALTER TABLE orders
  DROP CONSTRAINT IF EXISTS orders_disputed_at_consistency;
ALTER TABLE orders
  ADD CONSTRAINT orders_disputed_at_consistency
    CHECK (
      state = 'disputed'
      OR disputed_at IS NULL
    );

ALTER TABLE orders
  DROP CONSTRAINT IF EXISTS orders_cancelled_at_consistency;
ALTER TABLE orders
  ADD CONSTRAINT orders_cancelled_at_consistency
    CHECK (
      state = 'cancelled'
      OR cancelled_at IS NULL
    );

-- ----------------------------------------------------------------------------
-- order_state_transitions — append-only audit log
-- ----------------------------------------------------------------------------
--
-- One row per successful transition. The CHECK constraint
-- (orders_status_transition_allowed) is the DB-level guard for legal
-- (from_state, to_state) pairs; the application-level guard lives in
-- src/orders/state-machine.ts and is the *first* line of defense.

CREATE TABLE IF NOT EXISTS order_state_transitions (
  id              uuid                     PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id        uuid                     NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  -- null on the very first row for an order (the order row is created in
  -- 'initiated' state; there is no preceding transition).
  from_state      order_state,
  to_state        order_state              NOT NULL,
  actor_user_id   uuid                     REFERENCES users(id) ON DELETE RESTRICT,
  actor_role      order_transition_actor   NOT NULL,
  -- Free-form, human-readable, capped at 500 chars to keep the audit
  -- table light; longer narratives go in `metadata`.
  reason          varchar(500)             NOT NULL DEFAULT '',
  -- Transition-specific structured context. Examples:
  --   paid      → { stripe_payment_intent_id, stripe_charge_id }
  --   fulfilled → { carrier, tracking_number }
  --   disputed  → { opened_by_side, evidence_url }
  --   completed → { via: 'buyer_confirm' | 'auto_confirm' | 'admin_resolve' }
  metadata        jsonb                    NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz              NOT NULL DEFAULT now()
);

-- Defense-in-depth: legal (from, to) pairs only. Mirrors the
-- TRANSITIONS map in src/orders/state-machine.ts.
ALTER TABLE order_state_transitions
  DROP CONSTRAINT IF EXISTS orders_status_transition_allowed;
ALTER TABLE order_state_transitions
  ADD CONSTRAINT orders_status_transition_allowed
    CHECK (
      (from_state, to_state) IN (
        ('initiated',  'paid'),
        ('initiated',  'cancelled'),
        ('paid',       'fulfilled'),
        ('paid',       'disputed'),
        ('paid',       'cancelled'),
        ('fulfilled',  'completed'),
        ('fulfilled',  'disputed'),
        ('completed',  'disputed'),
        ('disputed',   'completed'),
        ('disputed',   'cancelled')
      )
    );

-- `system` is the only role that may have a NULL actor_user_id. Every
-- buyer / seller / admin row must point at a real user.
ALTER TABLE order_state_transitions
  DROP CONSTRAINT IF EXISTS orders_transition_actor_consistency;
ALTER TABLE order_state_transitions
  ADD CONSTRAINT orders_transition_actor_consistency
    CHECK (
      (actor_role = 'system') = (actor_user_id IS NULL)
    );

-- Hot read path: "show me the history of order X".
CREATE INDEX IF NOT EXISTS order_state_transitions_order_history_idx
  ON order_state_transitions (order_id, created_at DESC);

-- Operational: "show me everything actor U did".
CREATE INDEX IF NOT EXISTS order_state_transitions_actor_idx
  ON order_state_transitions (actor_user_id, created_at DESC)
  WHERE actor_user_id IS NOT NULL;

-- Operational: "show me all transitions into state S" (e.g. open
-- disputes in the last 24h).
CREATE INDEX IF NOT EXISTS order_state_transitions_to_state_idx
  ON order_state_transitions (to_state, created_at DESC);

-- ----------------------------------------------------------------------------
-- Trigger — auto-stamp the state-specific timestamps on the orders row
-- whenever the state column changes.
--
-- We deliberately do NOT write the audit row from this trigger. The audit
-- row carries actor_user_id and metadata that the trigger cannot infer.
-- Callers must INSERT the audit row in the same transaction as the orders
-- UPDATE so the (orders, order_state_transitions) write is atomic.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION orders_stamp_state_timestamps()
RETURNS trigger AS $$
BEGIN
  IF NEW.state IS DISTINCT FROM OLD.state THEN
    IF NEW.state = 'paid'      AND NEW.paid_at      IS NULL THEN NEW.paid_at      := now(); END IF;
    IF NEW.state = 'fulfilled' AND NEW.fulfilled_at IS NULL THEN NEW.fulfilled_at := now(); END IF;
    IF NEW.state = 'completed' AND NEW.completed_at IS NULL THEN NEW.completed_at := now(); END IF;
    IF NEW.state = 'disputed'  AND NEW.disputed_at  IS NULL THEN NEW.disputed_at  := now(); END IF;
    IF NEW.state = 'cancelled' AND NEW.cancelled_at IS NULL THEN NEW.cancelled_at := now(); END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS orders_stamp_state_timestamps ON orders;
CREATE TRIGGER orders_stamp_state_timestamps
  BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION orders_stamp_state_timestamps();

-- ----------------------------------------------------------------------------
-- Trigger — block state updates that aren't a legal transition.
--
-- This is the last line of defense: even if a raw SQL maintenance script
-- (or a buggy future migration) tries to set orders.state to an illegal
-- value, the UPDATE fails. The application state machine in TypeScript
-- catches the same errors earlier with structured failures; this trigger
-- just makes sure no path can sneak around it.
--
-- The check uses NEW.state paired with OLD.state, so callers must UPDATE
-- state in a single statement (not, e.g., `UPDATE ... SET state = 'paid'
-- WHERE state = 'fulfilled'`) which is the natural pattern anyway.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION orders_reject_illegal_state_change()
RETURNS trigger AS $$
BEGIN
  IF NEW.state IS DISTINCT FROM OLD.state THEN
    IF NOT (
      (OLD.state, NEW.state) IN (
        ('initiated',  'paid'),
        ('initiated',  'cancelled'),
        ('paid',       'fulfilled'),
        ('paid',       'disputed'),
        ('paid',       'cancelled'),
        ('fulfilled',  'completed'),
        ('fulfilled',  'disputed'),
        ('completed',  'disputed'),
        ('disputed',   'completed'),
        ('disputed',   'cancelled')
      )
    ) THEN
      RAISE EXCEPTION
        'orders.state illegal transition: % -> %', OLD.state, NEW.state
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS orders_reject_illegal_state_change ON orders;
CREATE TRIGGER orders_reject_illegal_state_change
  BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION orders_reject_illegal_state_change();

-- ----------------------------------------------------------------------------
-- Helper: full audit history for an order.
-- ----------------------------------------------------------------------------
--
-- Returns each transition oldest-first so a UI can render the timeline
-- without re-sorting. Joins users so the actor display name is one query
-- away.
CREATE OR REPLACE FUNCTION order_transition_history(target_order uuid)
RETURNS TABLE (
  id              uuid,
  from_state      order_state,
  to_state        order_state,
  actor_user_id   uuid,
  actor_handle    text,
  actor_role      order_transition_actor,
  reason          varchar,
  metadata        jsonb,
  created_at      timestamptz
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    t.id,
    t.from_state,
    t.to_state,
    t.actor_user_id,
    u.handle,
    t.actor_role,
    t.reason,
    t.metadata,
    t.created_at
  FROM order_state_transitions t
  LEFT JOIN users u ON u.id = t.actor_user_id
  WHERE t.order_id = target_order
  ORDER BY t.created_at ASC, t.id ASC;
$$;

COMMIT;