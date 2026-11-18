-- The spans table's planner statistics are read whole, not sampled
-- (`tables-analysed-whole` in plaid.server.sql, SCL6-1): a sample of the
-- first rows of `idx_spans_layer_value` says one span per (layer, value),
-- and Grew patterns with two tagged nodes then passed the 30 s limit.
-- Statistics taken before were sampled, and the refresh takes a table
-- again only when it has grown tenfold, so they are taken whole here, once,
-- before the server answers anyone (0.3 s for 600,000 spans). A table with
-- no rows gets no statistics.
ANALYZE spans;
