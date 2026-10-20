-- Nothing to undo: the removed rows cannot be brought back, and the read
-- takes the rows they named live. Restore the copy taken before deploying to
-- get them back. Running the rebuild again removes nothing it should keep.
DROP TABLE IF EXISTS lazy_dropped;
