-- Index supporting value-filtered span lookups for the query language
-- (plaid.sql.query.*). The query compiler emits predicates of the shape
-- `span_layer_id IN (...) AND value = ?` (e.g. "all NOUN spans on the POS
-- layer"); without this index the planner drives a sequence query from a full
-- scan of span_tokens. With it, a cross-project "NOUN immediately followed by
-- VERB" over 200k tokens drops from ~1s to ~0.4s and the single-project case to
-- single-digit ms (measured 2026-06-02). `value` is a JSON-encoded scalar, so
-- the index keys on its stored literal form (e.g. '"NOUN"').
CREATE INDEX IF NOT EXISTS idx_spans_layer_value ON spans(span_layer_id, value);
