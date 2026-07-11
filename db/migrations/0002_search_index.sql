-- YIL-8 — Postgres full-text search index for marketplace listings.
--
-- This is a hand-authored bootstrap migration. It must be applied BEFORE
-- drizzle-kit generates further migrations, and it is idempotent so it is
-- safe to re-run. Drizzle's auto-migrations will NOT include the search
-- column / indexes / functions (see schema.ts comment) — this file is the
-- source of truth for them.
--
-- Apply order:
--   1. drizzle-kit-generated migrations land first and create `listings`.
--   2. This file adds the search column, GIN indexes, and helper functions.
--
-- Run inside a transaction:
--   psql -v ON_ERROR_STOP=1 -f db/migrations/0002_search_index.sql
--
-- Requires: PostgreSQL >= 14, contrib modules `pg_trgm`.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- 1. Weighted search vector. Generated from `title` (weight A) and
--    `description` (weight B). Maintained by Postgres, never written by app.
ALTER TABLE listings
  ADD COLUMN IF NOT EXISTS search_vector tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(title, '')),       'A') ||
    setweight(to_tsvector('english', coalesce(description, '')), 'B')
  ) STORED;

-- 2. GIN over search_vector — primary FTS path.
CREATE INDEX IF NOT EXISTS listings_search_vector_gin_idx
  ON listings USING GIN (search_vector);

-- 3. Trigram GIN on lower(title) — typo-tolerant prefix fallback.
CREATE INDEX IF NOT EXISTS listings_title_trgm_gin_idx
  ON listings USING GIN (lower(title) gin_trgm_ops);

-- 4. Helper: ranked FTS search with stability tiebreaker.
--
-- Usage:
--   SELECT * FROM listings_search('vintage camera', 20, 0);
CREATE OR REPLACE FUNCTION listings_search(
  query_text   text,
  result_limit integer DEFAULT 20,
  offset_rows  integer DEFAULT 0
)
RETURNS TABLE (
  id          uuid,
  title       text,
  description text,
  rank        real
)
LANGUAGE sql
STABLE
AS $$
  WITH q AS (
    SELECT websearch_to_tsquery('english', coalesce(query_text, '')) AS tsq
  )
  SELECT
    l.id,
    l.title,
    l.description,
    ts_rank_cd(l.search_vector, q.tsq) AS rank
  FROM listings l, q
  WHERE l.deleted_at IS NULL
    AND l.search_vector @@ q.tsq
  ORDER BY rank DESC, l.created_at DESC
  LIMIT  result_limit
  OFFSET offset_rows;
$$;

-- 5. Helper: typo-tolerant fallback when FTS finds nothing.
CREATE OR REPLACE FUNCTION listings_search_trgm(
  query_text   text,
  result_limit integer DEFAULT 20
)
RETURNS TABLE (
  id          uuid,
  title       text,
  description text,
  similarity  real
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    l.id,
    l.title,
    l.description,
    similarity(lower(l.title), lower(query_text)) AS similarity
  FROM listings l
  WHERE l.deleted_at IS NULL
    AND lower(l.title) % lower(query_text)
  ORDER BY similarity DESC, l.created_at DESC
  LIMIT result_limit;
$$;

COMMIT;