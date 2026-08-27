DROP TABLE IF EXISTS user_avatars;
--;;
-- Requires SQLite >= 3.35 for DROP COLUMN (sqlite-jdbc 3.50.x is well past it).
ALTER TABLE users DROP COLUMN avatar_hash;
