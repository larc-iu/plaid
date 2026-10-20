-- The audit log by target, now for every table (2026-10-20). Before a
-- text, token, span, relation or vocab link is changed, core asks whether
-- any audit row names it, since an import leaves the rows it makes
-- unrecorded until then (plaid.sql.audit-write, "Lazy rows"). That question
-- is a seek on this index, for tokens, texts and links too.
DROP INDEX idx_audit_writes_target;
--;;
CREATE INDEX idx_audit_writes_target ON audit_writes (target_table, target_id, ts DESC, seq DESC);
