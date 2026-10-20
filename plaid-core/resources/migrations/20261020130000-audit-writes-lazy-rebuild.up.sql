-- Rebuild `audit_writes` for lazy import rows (2026-10-20, Luke's Q1 a), in
-- one pass over the table.
--
-- 1. The insert row of a text, token, span, relation or vocab link goes when
--    it is the row's only audit row, the row still exists, and it was
--    written by the operation that created its document, or by an operation
--    of that operation's group, before any operation outside that group
--    (outside that operation, with no group) wrote the document. These are
--    exactly the rows core no longer writes (plaid.sql.audit-write, "Lazy
--    rows"), and the as-of read takes such a row live, as existing since its
--    document was created (plaid.history.read).
-- 2. Every image loses `id` and `document_id`, which the row's own columns
--    hold (target_id, document_id) and the reader puts back, as core writes
--    them now.
--
-- The rows keep their keys and their order. The indexes are built after the
-- copy, the target index over every table (20261020120000).
--
-- Irreversible: the down migration cannot bring the removed rows back. Take
-- a copy of the database off the machine before deploying it. It holds the
-- write lock for the whole rebuild and needs free disk for the kept rows a
-- second time while it runs. The file does not shrink afterwards (freed pages
-- go to the freelist, auto_vacuum is NONE). Run a manual VACUUM at a quiet
-- hour to return the space.
CREATE TEMP TABLE lazy_creators AS
SELECT aw.target_id AS doc, aw.op_id AS op, o.group_id AS grp, min(aw.ts) AS ts
FROM audit_writes aw
JOIN operations o ON o.id = aw.op_id
WHERE aw.target_table = 'documents' AND aw.change_type = 'insert'
GROUP BY aw.target_id;
--;;
CREATE TEMP TABLE lazy_windows AS
SELECT c.doc, c.op, c.grp,
       (SELECT min(aw.ts)
        FROM audit_writes aw
        JOIN operations o ON o.id = aw.op_id
        WHERE aw.document_id = c.doc
          AND CASE WHEN c.grp IS NULL THEN aw.op_id <> c.op
                   ELSE (o.group_id IS NULL OR o.group_id <> c.grp) END) AS ends
FROM lazy_creators c;
--;;
CREATE UNIQUE INDEX lazy_windows_doc ON lazy_windows (doc);
--;;
CREATE TEMP TABLE lazy_dropped AS
SELECT aw.id
FROM audit_writes aw
JOIN lazy_windows w ON w.doc = aw.document_id
JOIN operations o ON o.id = aw.op_id
WHERE aw.target_table IN ('texts', 'tokens', 'spans', 'relations', 'vocab_links')
  AND aw.change_type = 'insert'
  AND (aw.op_id = w.op OR (w.grp IS NOT NULL AND o.group_id = w.grp))
  AND (w.ends IS NULL OR aw.ts < w.ends)
  AND NOT EXISTS (SELECT 1 FROM audit_writes b
                  WHERE b.target_table = aw.target_table AND b.target_id = aw.target_id AND b.id <> aw.id)
  AND CASE aw.target_table
        WHEN 'texts' THEN EXISTS (SELECT 1 FROM texts r WHERE r.id = aw.target_id)
        WHEN 'tokens' THEN EXISTS (SELECT 1 FROM tokens r WHERE r.id = aw.target_id)
        WHEN 'spans' THEN EXISTS (SELECT 1 FROM spans r WHERE r.id = aw.target_id)
        WHEN 'relations' THEN EXISTS (SELECT 1 FROM relations r WHERE r.id = aw.target_id)
        WHEN 'vocab_links' THEN EXISTS (SELECT 1 FROM vocab_links r WHERE r.id = aw.target_id)
      END;
--;;
CREATE UNIQUE INDEX lazy_dropped_id ON lazy_dropped (id);
--;;
CREATE TABLE audit_writes_new (
  id             INTEGER PRIMARY KEY,
  op_id          TEXT NOT NULL REFERENCES operations(id) ON DELETE CASCADE,
  -- seq: ordinal of this write within its op. All rows in one op share its
  -- `ts`, so (ts, seq) is the order the log is replayed in. A row recorded
  -- whole before its first change has a negative seq (plaid.sql.audit-write).
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
  (id, op_id, seq, target_table, target_id, change_type, post_image, ts, document_id, vocab_layer_id)
SELECT id, op_id, seq, target_table, target_id, change_type,
       CASE WHEN post_image IS NULL THEN NULL ELSE json_remove(post_image, '$.id', '$.document_id') END,
       ts, document_id, vocab_layer_id
FROM audit_writes
WHERE id NOT IN (SELECT id FROM lazy_dropped)
ORDER BY id;
--;;
DROP TABLE audit_writes;
--;;
ALTER TABLE audit_writes_new RENAME TO audit_writes;
--;;
CREATE UNIQUE INDEX idx_audit_writes_op_seq ON audit_writes (op_id, seq);
--;;
CREATE INDEX idx_audit_writes_document_ts ON audit_writes (document_id, ts, seq);
--;;
CREATE INDEX idx_audit_writes_target ON audit_writes (target_table, target_id, ts DESC, seq DESC);
--;;
CREATE INDEX idx_audit_writes_vocab_layer_ts ON audit_writes (vocab_layer_id, ts, seq)
  WHERE vocab_layer_id IS NOT NULL;
--;;
CREATE INDEX idx_audit_writes_deleted ON audit_writes (target_table, target_id)
  WHERE change_type = 'delete';
--;;
DROP TABLE lazy_dropped;
--;;
DROP TABLE lazy_windows;
--;;
DROP TABLE lazy_creators;
