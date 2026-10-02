-- The audit log by target, now for spans and relations too (2026-10-02).
-- A value-set check exempts a value an import, a copy or a restore set,
-- which it reads from each row's history (plaid.sql.constraints.layer
-- `import-set-ids`). Without spans in this index, closing a tagset over
-- 37,653 off-list values scanned the log ten times and held the write lock
-- for 17 s. On the 2026-10-01 production copy the index grows by about
-- 2M entries and takes 4 s to build on larc.
DROP INDEX idx_audit_writes_target;
--;;
CREATE INDEX idx_audit_writes_target ON audit_writes (target_table, target_id, ts DESC, seq DESC)
  WHERE target_table = 'documents'
     OR target_table = 'text_layers'
     OR target_table = 'token_layers'
     OR target_table = 'span_layers'
     OR target_table = 'relation_layers'
     OR target_table = 'vocab_items'
     OR target_table = 'vocab_layers'
     OR target_table = 'spans'
     OR target_table = 'relations';
