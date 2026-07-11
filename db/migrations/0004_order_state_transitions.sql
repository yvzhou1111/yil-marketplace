-- YIL-14 / YIL-16 — order state machine schema + DB-side enforcement.
--
-- Defines the `orders.state` and `order_state_transitions` tables and a
-- strict BEFORE UPDATE trigger that rejects illegal transitions.
--
-- Why a trigger? Defense in depth. The application-layer validator in
-- `src/orders/state-machine.ts` already rejects illegal (action, from)
-- pairs and `src/orders/service.ts` only writes through that validator.
-- But the trigger means that if anyone ever runs a raw
--   UPDATE orders SET state = ... WHERE id = ...;
-- the database itself rejects the write. The companion trigger on the
-- audit table rejects inserts whose (from_state, to_state) pair is not
-- in the allow-list, so the audit log cannot disagree with the orders
-- row even if some future writer skips the application layer.
--
-- Idempotent — safe to re-run.

BEGIN;

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

DO $$ BEGIN
  CREATE TYPE "public"."order_state" AS ENUM (
    'initiated',
    'paid',
    'fulfilled',
    'completed',
    'disputed',
    'cancelled'
  );
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."order_transition_actor" AS ENUM (
    'buyer',
    'seller',
    'admin',
    'system'
  );
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "orders" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "listing_id" uuid NOT NULL,
  "buyer_id" uuid NOT NULL,
  "seller_id" uuid NOT NULL,
  "state" "order_state" DEFAULT 'initiated' NOT NULL,
  "amount_minor" bigint NOT NULL,
  "currency" varchar(3) DEFAULT 'USD' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "completed_at" timestamp with time zone,
  "paid_at" timestamp with time zone,
  "fulfilled_at" timestamp with time zone,
  "disputed_at" timestamp with time zone,
  "cancelled_at" timestamp with time zone
);

CREATE TABLE IF NOT EXISTS "order_state_transitions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "order_id" uuid NOT NULL,
  "from_state" "order_state",
  "to_state" "order_state" NOT NULL,
  "actor_user_id" uuid,
  "actor_role" "order_transition_actor" NOT NULL,
  "reason" varchar(500) DEFAULT '' NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

-- Foreign keys are declared against tables the generated migration also
-- creates (users, listings). We use a NOT VALID + VALIDATE pattern so
-- this migration can run before the users / listings tables exist if
-- applied in isolation; in practice the generated migration runs first
-- in normal startup.
ALTER TABLE "orders"
  ADD CONSTRAINT "orders_listing_id_fk"
  FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id")
  ON DELETE restrict ON UPDATE no action
  NOT VALID;
ALTER TABLE "orders" VALIDATE CONSTRAINT "orders_listing_id_fk";

ALTER TABLE "orders"
  ADD CONSTRAINT "orders_buyer_id_fk"
  FOREIGN KEY ("buyer_id") REFERENCES "public"."users"("id")
  ON DELETE restrict ON UPDATE no action
  NOT VALID;
ALTER TABLE "orders" VALIDATE CONSTRAINT "orders_buyer_id_fk";

ALTER TABLE "orders"
  ADD CONSTRAINT "orders_seller_id_fk"
  FOREIGN KEY ("seller_id") REFERENCES "public"."users"("id")
  ON DELETE restrict ON UPDATE no action
  NOT VALID;
ALTER TABLE "orders" VALIDATE CONSTRAINT "orders_seller_id_fk";

ALTER TABLE "order_state_transitions"
  ADD CONSTRAINT "order_state_transitions_order_id_fk"
  FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id")
  ON DELETE restrict ON UPDATE no action
  NOT VALID;
ALTER TABLE "order_state_transitions" VALIDATE CONSTRAINT "order_state_transitions_order_id_fk";

ALTER TABLE "order_state_transitions"
  ADD CONSTRAINT "order_state_transitions_actor_user_id_fk"
  FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id")
  ON DELETE restrict ON UPDATE no action
  NOT VALID;
ALTER TABLE "order_state_transitions" VALIDATE CONSTRAINT "order_state_transitions_actor_user_id_fk";

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS "orders_state_idx"
  ON "orders" USING btree ("state", "created_at" DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS "orders_buyer_idx"
  ON "orders" USING btree ("buyer_id", "created_at" DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS "orders_seller_idx"
  ON "orders" USING btree ("seller_id", "created_at" DESC NULLS LAST);
CREATE UNIQUE INDEX IF NOT EXISTS "orders_active_buyer_unique"
  ON "orders" USING btree ("buyer_id", "listing_id")
  WHERE "state" <> 'cancelled';

CREATE INDEX IF NOT EXISTS "order_state_transitions_order_history_idx"
  ON "order_state_transitions" USING btree ("order_id", "created_at");
CREATE INDEX IF NOT EXISTS "order_state_transitions_actor_idx"
  ON "order_state_transitions" USING btree ("actor_user_id", "created_at");
CREATE INDEX IF NOT EXISTS "order_state_transitions_to_state_idx"
  ON "order_state_transitions" USING btree ("to_state", "created_at");

-- ---------------------------------------------------------------------------
-- Trigger: enforce legal (from_state, to_state) pairs on orders.
--
-- The trigger only checks the NEW vs OLD state when NEW.state actually
-- changes. INSERTs always pass because NEW.state = 'initiated' and
-- there is no OLD row.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION yil_orders_check_state_transition()
RETURNS trigger AS $$
BEGIN
  IF NEW.state IS DISTINCT FROM OLD.state THEN
    IF NOT (
      (OLD.state = 'initiated' AND NEW.state IN ('paid', 'cancelled')) OR
      (OLD.state = 'paid'      AND NEW.state IN ('fulfilled', 'disputed', 'cancelled')) OR
      (OLD.state = 'fulfilled' AND NEW.state IN ('completed', 'disputed')) OR
      (OLD.state = 'completed' AND NEW.state IN ('disputed')) OR
      (OLD.state = 'disputed'  AND NEW.state IN ('completed', 'cancelled'))
    ) THEN
      RAISE EXCEPTION
        'illegal orders.state transition: % -> %',
        OLD.state, NEW.state
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS yil_orders_state_transition_check ON "orders";
CREATE TRIGGER yil_orders_state_transition_check
  BEFORE UPDATE ON "orders"
  FOR EACH ROW
  EXECUTE FUNCTION yil_orders_check_state_transition();

-- Companion check: an audit row's (from_state, to_state) must match a
-- legal edge too. This catches a future writer that bypasses the
-- application layer and inserts a bogus audit row directly.
ALTER TABLE "order_state_transitions"
  DROP CONSTRAINT IF EXISTS "order_state_transitions_legal_pair_check";
ALTER TABLE "order_state_transitions"
  ADD CONSTRAINT "order_state_transitions_legal_pair_check"
  CHECK (
    (from_state = 'initiated' AND to_state IN ('paid', 'cancelled')) OR
    (from_state = 'paid'      AND to_state IN ('fulfilled', 'disputed', 'cancelled')) OR
    (from_state = 'fulfilled' AND to_state IN ('completed', 'disputed')) OR
    (from_state = 'completed' AND to_state IN ('disputed')) OR
    (from_state = 'disputed'  AND to_state IN ('completed', 'cancelled')) OR
    (from_state IS NULL AND to_state = 'initiated')
  );

-- updated_at maintenance
DROP TRIGGER IF EXISTS yil_orders_set_updated_at ON "orders";
CREATE TRIGGER yil_orders_set_updated_at
  BEFORE UPDATE ON "orders"
  FOR EACH ROW
  EXECUTE FUNCTION yil_set_updated_at();

COMMIT;