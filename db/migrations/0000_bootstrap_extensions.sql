-- YIL-5 — Bootstrap extensions + helpers required by the core schema.
--
-- Must run before any migration that uses `gen_random_uuid()` (the rest of the
-- schema) or `pg_trgm` (YIL-8). Idempotent — safe to re-run.

BEGIN;

-- gen_random_uuid() lives in pgcrypto (Postgres < 13) or is built-in
-- (Postgres >= 13). Enabling pgcrypto unconditionally is harmless on newer
-- versions and lets us support older clusters without forking the migration.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Required by YIL-8's full-text search + trigram fallback.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ----------------------------------------------------------------------------
-- updated_at trigger — reusable across every table with an updated_at column.
-- Drizzle's generated schema leaves updated_at to application code; we prefer
-- the database as the single source of truth so updates from any writer
-- (Drizzle, ad-hoc psql, future admin console) still bump the timestamp.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION yil_set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMIT;