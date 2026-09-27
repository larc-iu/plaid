-- An index on the time of every save (perf-operations-time-index, ruled 2026-09-27).
--
-- Reading a document as it was at T first asks which save came last at or
-- before T, across the whole server, to keep T out of the middle of an
-- atomic batch (plaid.history.read/effective-bound). With no index led by
-- `ts` that lookup walked the table, 49 ms at 190k operations and growing
-- with every save. The unscoped admin activity feed walks the same order.
CREATE INDEX idx_operations_ts ON operations(ts);
