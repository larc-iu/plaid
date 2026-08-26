-- Logical operation groups (audit-log grouping).
--
-- A client may wrap a run of low-level writes into ONE logical operation
-- ("Merge morphemes", "Re-transcribe") that the audit UI shows as a single
-- expandable row. The group is a client-minted correlation id stamped on
-- each `operations` row (`group_id`, mirrors `batch_id`) plus this table
-- holding the human message. Grouping is orthogonal to atomic batches: a
-- group may span several batches plus standalone ops, and is NOT a
-- transaction boundary (nothing rolls back if a later member fails).
--
-- The row is created LAZILY inside the first tagged op's own tx (INSERT OR
-- IGNORE) from `?group-id=` + `?group-message=` on the write, so there is
-- never an empty group and the row is atomic with its first member. The
-- message is client free text for readability only (same trust model as
-- `?audit-message=`); the forensic record (audit_writes) is untouched.
-- `user_id` gates the PATCH that refines the message (owner or admin).
CREATE TABLE operation_groups (
  id         TEXT PRIMARY KEY,
  message    TEXT NULL,
  user_id    TEXT NULL,
  created_at TEXT NOT NULL
);
--;;
ALTER TABLE operations ADD COLUMN group_id TEXT NULL;
--;;
CREATE INDEX idx_operations_group ON operations(group_id);
