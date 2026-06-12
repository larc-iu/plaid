-- Persistent "seen services" registry: one row per (project, service-id) ever
-- registered, so discovery can show offline services with a last-seen time.
-- Upserted on every service channel open (NOT audit-logged — operational
-- bookkeeping, same rationale as api_tokens.last_used_at). `extras` is the raw
-- JSON snapshot exactly as the service sent it on the query string.
CREATE TABLE seen_services (
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  service_id    TEXT NOT NULL,
  service_name  TEXT,
  description   TEXT,
  extras        TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL,
  PRIMARY KEY (project_id, service_id)
);
