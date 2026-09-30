-- Idempotent writes (2026-09-30). One row per write a client sent with an
-- Idempotency-Key, written in the same transaction as the write, so a retry
-- of the same key is answered from here instead of writing again. Only 2xx
-- answers are kept. Rows older than [idempotency] retention_hours are ignored
-- by the lookup and deleted by plaid.server.idempotency-sweep.
--
-- `user_id` has no ON DELETE clause, matching `comments.author_id`: users
-- are not deletable.
CREATE TABLE idempotency_keys (
  user_id     TEXT NOT NULL REFERENCES users(id),
  key         TEXT NOT NULL,
  fingerprint TEXT NOT NULL,      -- hex SHA-256, see plaid.rest-api.v1.idempotency
  method      TEXT NOT NULL,
  path        TEXT NOT NULL,      -- for the 422 message and debugging
  status      INTEGER NOT NULL,
  headers     TEXT NULL,          -- JSON: X-Document-Versions(-Omitted) only
  body        TEXT NULL,          -- JSON response body
  created_at  TEXT NOT NULL,
  PRIMARY KEY (user_id, key)
) WITHOUT ROWID;
--;;
-- The sweep: every row older than the retention, oldest first.
CREATE INDEX idx_idempotency_keys_created ON idempotency_keys(created_at);
--;;
-- A create that names its own id is refused when the id was used before,
-- including by a row since deleted (plaid.sql.common/claim-ids!). A deleted
-- row's id is found by its delete row in the audit log. The target index
-- covers only the layer, document and vocabulary tables, so spans, tokens,
-- relations and links would scan the whole log. This one holds the delete
-- rows alone, a small part of the log.
CREATE INDEX idx_audit_writes_deleted ON audit_writes(target_table, target_id)
  WHERE change_type = 'delete';
