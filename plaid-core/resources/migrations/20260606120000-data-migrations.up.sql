-- Tracking table for one-time, Clojure-driven DATA migrations — row-level
-- transforms that can't be expressed in pure SQL and must run exactly once at
-- a code cutover. Distinct from `schema_migrations` (migratus, DDL only).
--
-- First user: the UTF-16 -> Unicode code-point reinterpretation of token
-- offsets (plaid.migrate.codepoint-offsets). One marker row per completed unit
-- of work (id = "codepoint-offsets:text:<text-uuid>") is written INSIDE the
-- same transaction as that unit's row updates, which makes the transform
-- idempotent and safe to resume after a partial failure.
-- IF NOT EXISTS so a down (which deliberately keeps the table) followed by an up
-- doesn't fail — data migrations are forward-only (see the .down.sql).
CREATE TABLE IF NOT EXISTS data_migrations (
  id          TEXT PRIMARY KEY,
  applied_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
