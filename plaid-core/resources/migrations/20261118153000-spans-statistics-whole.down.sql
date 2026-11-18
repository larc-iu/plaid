-- Nothing to undo: statistics are not data, and the refresh keeps them.
-- migratus runs a down statement in a batch, which refuses a statement that
-- returns rows, so the no-op is a WHERE-false UPDATE.
UPDATE schema_migrations SET id = id WHERE 1 = 0;
