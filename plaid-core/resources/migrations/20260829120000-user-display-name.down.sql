DROP INDEX IF EXISTS idx_users_display_name_id;
--;;
-- Requires SQLite >= 3.35 for DROP COLUMN (sqlite-jdbc 3.50.x is well past it).
ALTER TABLE users DROP COLUMN display_name;
