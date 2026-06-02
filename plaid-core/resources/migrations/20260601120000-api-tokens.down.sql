DROP INDEX IF EXISTS idx_operations_token;
--;;
-- Requires SQLite >= 3.35 (sqlite-jdbc 3.50.x ships well past this). If the
-- driver ever predates DROP COLUMN this would need a table rebuild — down
-- migrations effectively never run in practice.
ALTER TABLE operations DROP COLUMN token_id;
--;;
DROP INDEX IF EXISTS idx_api_tokens_user;
--;;
DROP TABLE IF EXISTS api_tokens;
