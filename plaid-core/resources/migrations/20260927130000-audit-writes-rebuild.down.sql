-- Back to the TEXT key, the full target index and the ts index, without
-- vocab_layer_id. The old UUID keys are gone, so each row takes its
-- integer key as text (nothing ever read the key).
CREATE TABLE audit_writes_old (
  id           TEXT PRIMARY KEY,
  op_id        TEXT NOT NULL REFERENCES operations(id) ON DELETE CASCADE,
  seq          INTEGER NOT NULL,
  target_table TEXT NOT NULL,
  target_id    TEXT NOT NULL,
  change_type  TEXT NOT NULL CHECK (change_type IN ('insert', 'update', 'delete', 'doc-version-bump')),
  post_image   TEXT NULL,
  ts           TEXT NOT NULL,
  document_id  TEXT NULL,
  UNIQUE (op_id, seq)
);
--;;
INSERT INTO audit_writes_old
  (id, op_id, seq, target_table, target_id, change_type, post_image, ts, document_id)
SELECT CAST(id AS TEXT), op_id, seq, target_table, target_id, change_type, post_image, ts, document_id
FROM audit_writes
ORDER BY id;
--;;
DROP TABLE audit_writes;
--;;
ALTER TABLE audit_writes_old RENAME TO audit_writes;
--;;
CREATE INDEX idx_audit_writes_target ON audit_writes(target_table, target_id, ts DESC, seq DESC);
--;;
CREATE INDEX idx_audit_writes_ts ON audit_writes(ts);
--;;
CREATE INDEX idx_audit_writes_document_ts ON audit_writes (document_id, ts, seq);
