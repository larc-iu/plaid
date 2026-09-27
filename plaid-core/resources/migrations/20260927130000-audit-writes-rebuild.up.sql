-- Rebuild `audit_writes` (audit-storage-trims and audit-vocab-scope-column,
-- both ruled 2026-09-27), in one pass over the table.
--
-- 1. The key becomes an INTEGER alias of the rowid. The TEXT UUID it
--    replaces was read by nothing, and cost a 36-byte value in every row
--    plus an index of its own.
-- 2. The index on `ts` alone is not rebuilt. It served the removed XTDB
--    tailer and nothing has read it since.
-- 3. The (target_table, target_id) index covers only the tables that are
--    read by target: the documents row, the four layer tables and the two
--    vocabulary tables. Spans, tokens, relations and links, most of the
--    log, are read by document and are left out of it. The predicate is an
--    OR of equalities on purpose: SQLite uses a partial index when a term
--    of the query's WHERE matches one arm of it, and an IN list would
--    match nothing (plaid.history.read queries one table at a time).
-- 4. A `vocab_layer_id` column, the vocabulary a row belongs to, beside
--    `document_id` and indexed the same way, so one vocabulary's history
--    is an index range instead of a scan of the whole log. A vocabulary's
--    own row carries its id, an entry's row the vocabulary the entry is
--    in. An entry's delete row has no image, so it takes the vocabulary
--    from the entry's earlier rows (entries never change vocabulary).
--
-- The rows keep their order: the SELECT reads the old table in rowid
-- order, which is the order they were written. The indexes are built
-- after the copy, which is faster than maintaining them row by row.
--
-- This holds the write lock for the whole rebuild and needs free disk for
-- a second copy of the table while it runs. The file does not shrink
-- afterwards (freed pages go to the freelist, auto_vacuum is NONE). Run a
-- manual VACUUM at a quiet hour to return the space.
CREATE TABLE audit_writes_new (
  id             INTEGER PRIMARY KEY,
  op_id          TEXT NOT NULL REFERENCES operations(id) ON DELETE CASCADE,
  -- seq: ordinal of this write within its op (0-based). All rows in one
  -- op share its `ts`, so (ts, seq) is the order the log is replayed in.
  seq            INTEGER NOT NULL,
  target_table   TEXT NOT NULL,
  target_id      TEXT NOT NULL,
  change_type    TEXT NOT NULL CHECK (change_type IN ('insert', 'update', 'delete', 'doc-version-bump')),
  post_image     TEXT NULL,
  ts             TEXT NOT NULL,
  document_id    TEXT NULL,
  vocab_layer_id TEXT NULL
);
--;;
INSERT INTO audit_writes_new
  (op_id, seq, target_table, target_id, change_type, post_image, ts, document_id, vocab_layer_id)
SELECT op_id, seq, target_table, target_id, change_type, post_image, ts, document_id,
       CASE target_table
         WHEN 'vocab_layers' THEN target_id
         WHEN 'vocab_items' THEN json_extract(post_image, '$.vocab_layer_id')
       END
FROM audit_writes
ORDER BY rowid;
--;;
DROP TABLE audit_writes;
--;;
ALTER TABLE audit_writes_new RENAME TO audit_writes;
--;;
-- (op_id, seq) is unique: one ordinal per row of an op. Also what the
-- purge after a project delete finds a project's rows by.
CREATE UNIQUE INDEX idx_audit_writes_op_seq ON audit_writes (op_id, seq);
--;;
-- As-of reconstruction and restore: every row of one document, in order.
CREATE INDEX idx_audit_writes_document_ts ON audit_writes (document_id, ts, seq);
--;;
CREATE INDEX idx_audit_writes_target ON audit_writes (target_table, target_id, ts DESC, seq DESC)
  WHERE target_table = 'documents'
     OR target_table = 'text_layers'
     OR target_table = 'token_layers'
     OR target_table = 'span_layers'
     OR target_table = 'relation_layers'
     OR target_table = 'vocab_items'
     OR target_table = 'vocab_layers';
--;;
-- An entry's delete row, whose vocabulary the copy above could not read.
UPDATE audit_writes
SET vocab_layer_id = (
  SELECT a.vocab_layer_id FROM audit_writes a
  WHERE a.target_table = 'vocab_items'
    AND a.target_id = audit_writes.target_id
    AND a.vocab_layer_id IS NOT NULL
  LIMIT 1)
WHERE target_table = 'vocab_items' AND vocab_layer_id IS NULL;
--;;
-- One vocabulary's history: every row of it, in order.
CREATE INDEX idx_audit_writes_vocab_layer_ts ON audit_writes (vocab_layer_id, ts, seq)
  WHERE vocab_layer_id IS NOT NULL;
