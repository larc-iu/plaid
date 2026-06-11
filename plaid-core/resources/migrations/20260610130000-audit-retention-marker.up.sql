-- Forward-compat contract for audit-log retention. No prune code exists
-- yet, but the audit log is the history replica's only replay source:
-- a cold rebuild against a pruned log silently produces PARTIAL
-- documents (the replayer's patch-docs creates-on-absent, and junction
-- folds carried by pruned :update rows are simply lost). So the
-- contract is: any future prune MUST record its high-water mark here,
-- and the history tailer REFUSES a cold rebuild while a marker is set
-- (plaid.history.tailer/check-pruned-audit-log!).
CREATE TABLE audit_retention (
    id              INTEGER PRIMARY KEY CHECK (id = 1),
    pruned_below_ts TEXT NOT NULL,
    pruned_at       TEXT NOT NULL
);
