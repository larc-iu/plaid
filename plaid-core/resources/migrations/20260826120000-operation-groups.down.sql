DROP INDEX IF EXISTS idx_operations_group;
--;;
ALTER TABLE operations DROP COLUMN group_id;
--;;
DROP TABLE IF EXISTS operation_groups;
