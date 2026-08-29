-- Requires SQLite >= 3.35 for DROP COLUMN (sqlite-jdbc 3.50.x is well past it).
ALTER TABLE vocab_layers DROP COLUMN modified_at;
--;;
ALTER TABLE vocab_layers DROP COLUMN created_at;
