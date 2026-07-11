-- YIL-10 — Reviews and ratings.
-- Run inside a transaction:
--   psql -v ON_ERROR_STOP=1 -f db/migrations/0002_reviews.sql
--
-- Requires: PostgreSQL >= 14 (uses gen_random_uuid from pgcrypto and partial
-- unique indexes). Mirrors the Drizzle schema in src/db/schema.ts.
--
-- Pre-existing tables this migration assumes (owned by YIL-5):
--   public.users     (id uuid PK)
--   public.listings  (id uuid PK)

BEGIN;

-- ----------------------------------------------------------------------------
-- Enums
-- ----------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'order_state') THEN
    CREATE TYPE order_state AS ENUM (
      'initiated',
      'paid',
      'fulfilled',
      'completed',
      'disputed',
      'cancelled'
    );
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'review_role') THEN
    CREATE TYPE review_role AS ENUM ('buyer', 'seller');
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'review_flag_reason') THEN
    CREATE TYPE review_flag_reason AS ENUM (
      'spam',
      'harassment',
      'hate',
      'threat',
      'doxxing',
      'off_topic',
      'other'
    );
  END IF;
END$$;

-- ----------------------------------------------------------------------------
-- orders
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS orders (
  id              uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id      uuid         NOT NULL REFERENCES listings(id) ON DELETE RESTRICT,
  buyer_id        uuid         NOT NULL REFERENCES users(id)    ON DELETE RESTRICT,
  seller_id       uuid         NOT NULL REFERENCES users(id)    ON DELETE RESTRICT,
  state           order_state  NOT NULL DEFAULT 'initiated',
  amount_minor    bigint       NOT NULL CHECK (amount_minor >= 0),
  currency        varchar(3)   NOT NULL DEFAULT 'USD',
  created_at      timestamptz  NOT NULL DEFAULT now(),
  updated_at      timestamptz  NOT NULL DEFAULT now(),
  completed_at    timestamptz
);

CREATE INDEX IF NOT EXISTS orders_seller_idx
  ON orders (seller_id, created_at DESC);
CREATE INDEX IF NOT EXISTS orders_buyer_idx
  ON orders (buyer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS orders_state_idx
  ON orders (state, created_at DESC);

-- One active (non-cancelled) order per (buyer, listing) at a time.
-- Buyers can retry after cancelling.
CREATE UNIQUE INDEX IF NOT EXISTS orders_active_buyer_unique
  ON orders (buyer_id, listing_id)
  WHERE state <> 'cancelled';

-- ----------------------------------------------------------------------------
-- reviews
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS reviews (
  id              uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id        uuid         NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  reviewer_id     uuid         NOT NULL REFERENCES users(id)  ON DELETE RESTRICT,
  reviewee_id     uuid         NOT NULL REFERENCES users(id)  ON DELETE RESTRICT,
  role            review_role  NOT NULL,
  rating          integer      NOT NULL CHECK (rating BETWEEN 1 AND 5),
  body            text         NOT NULL DEFAULT '',
  hidden_at       timestamptz,
  hidden_reason   text,
  created_at      timestamptz  NOT NULL DEFAULT now(),
  updated_at      timestamptz  NOT NULL DEFAULT now()
);

-- One review per (order, role). The buyer writes one for the seller, the
-- seller writes one for the buyer. This is what makes reviews "two-sided".
CREATE UNIQUE INDEX IF NOT EXISTS reviews_one_per_side_unique
  ON reviews (order_id, role);

CREATE INDEX IF NOT EXISTS reviews_reviewee_idx
  ON reviews (reviewee_id, created_at DESC);
CREATE INDEX IF NOT EXISTS reviews_reviewer_idx
  ON reviews (reviewer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS reviews_order_idx
  ON reviews (order_id);

-- ----------------------------------------------------------------------------
-- review_flags  (user-driven abuse reports)
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS review_flags (
  id              uuid                  PRIMARY KEY DEFAULT gen_random_uuid(),
  review_id       uuid                  NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  reporter_id     uuid                  NOT NULL REFERENCES users(id)   ON DELETE RESTRICT,
  reason          review_flag_reason    NOT NULL,
  notes           text                  NOT NULL DEFAULT '',
  created_at      timestamptz           NOT NULL DEFAULT now(),
  resolved_at     timestamptz,
  resolution      text
);

-- One user can flag the same review once. Duplicate reports are merged.
CREATE UNIQUE INDEX IF NOT EXISTS review_flags_one_per_reporter
  ON review_flags (review_id, reporter_id);

-- Common read: all open flags on a review.
CREATE INDEX IF NOT EXISTS review_flags_open_by_review_idx
  ON review_flags (review_id)
  WHERE resolved_at IS NULL;

-- ----------------------------------------------------------------------------
-- review_moderation_actions  (append-only audit of moderator decisions)
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS review_moderation_actions (
  id              uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  review_id       uuid         NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  actor_id        uuid         NOT NULL REFERENCES users(id)   ON DELETE RESTRICT,
  action          text         NOT NULL,
  reason          text         NOT NULL DEFAULT '',
  created_at      timestamptz  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS review_moderation_actions_review_idx
  ON review_moderation_actions (review_id, created_at DESC);

-- ----------------------------------------------------------------------------
-- updated_at triggers  (mirror listings/users convention from migration 0000)
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION reviews_set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS reviews_set_updated_at ON reviews;
CREATE TRIGGER reviews_set_updated_at
  BEFORE UPDATE ON reviews
  FOR EACH ROW EXECUTE FUNCTION reviews_set_updated_at();

CREATE OR REPLACE FUNCTION orders_set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS orders_set_updated_at ON orders;
CREATE TRIGGER orders_set_updated_at
  BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION orders_set_updated_at();

-- ----------------------------------------------------------------------------
-- Helper: aggregate reviews for a user (count + average + distribution).
-- Excludes hidden reviews so moderators can quietly retire a review
-- without poisoning the user's public rating.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION reviews_aggregate_for_user(target_user uuid)
RETURNS TABLE (
  total         bigint,
  visible       bigint,
  hidden        bigint,
  rating_avg    numeric,
  rating_1      bigint,
  rating_2      bigint,
  rating_3      bigint,
  rating_4      bigint,
  rating_5      bigint
)
LANGUAGE sql
STABLE
AS $$
  WITH agg AS (
    SELECT
      count(*)                                       AS total,
      count(*) FILTER (WHERE hidden_at IS NULL)      AS visible,
      count(*) FILTER (WHERE hidden_at IS NOT NULL)  AS hidden,
      avg(rating) FILTER (WHERE hidden_at IS NULL)    AS rating_avg,
      count(*) FILTER (WHERE rating = 1 AND hidden_at IS NULL) AS rating_1,
      count(*) FILTER (WHERE rating = 2 AND hidden_at IS NULL) AS rating_2,
      count(*) FILTER (WHERE rating = 3 AND hidden_at IS NULL) AS rating_3,
      count(*) FILTER (WHERE rating = 4 AND hidden_at IS NULL) AS rating_4,
      count(*) FILTER (WHERE rating = 5 AND hidden_at IS NULL) AS rating_5
    FROM reviews
    WHERE reviewee_id = target_user
  )
  SELECT
    agg.total,
    agg.visible,
    agg.hidden,
    agg.rating_avg,
    agg.rating_1,
    agg.rating_2,
    agg.rating_3,
    agg.rating_4,
    agg.rating_5
  FROM agg;
$$;

-- ----------------------------------------------------------------------------
-- Helper: open flag count per review. Threshold logic lives in app code;
-- this is just the cheap count for the admin console's queue.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION review_open_flag_count(target_review uuid)
RETURNS bigint
LANGUAGE sql
STABLE
AS $$
  SELECT count(*)
  FROM review_flags
  WHERE review_id = target_review
    AND resolved_at IS NULL;
$$;

COMMIT;