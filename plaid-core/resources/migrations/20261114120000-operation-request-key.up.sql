-- The Idempotency-Key a write was sent with, kept on each of its operations
-- (2026-11-14). The idempotency store forgets a key after a day, and a job
-- worker that lost the answer to a write, or crashed while it was sent, asks
-- whether it landed after any time: it sends every try of a write under keys
-- of its own seed (`<seed>.<n>`) and asks core which of them exist
-- (`POST /jobs/{id}/landed`). Set by the server from the request's header, on
-- every operation of a keyed write or batch, NULL for an unkeyed write and on
-- operations from before this column. The index serves that lookup, a range
-- of keys under one seed.
ALTER TABLE operations ADD COLUMN request_key TEXT NULL;
--;;
CREATE INDEX idx_operations_request_key ON operations(request_key);
