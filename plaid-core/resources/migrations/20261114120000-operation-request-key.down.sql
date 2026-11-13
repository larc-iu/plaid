DROP INDEX IF EXISTS idx_operations_request_key;
--;;
ALTER TABLE operations DROP COLUMN request_key;
