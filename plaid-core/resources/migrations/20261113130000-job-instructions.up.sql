-- A job is instructions and documents (2026-11-13): it has no task types.
-- The `tasks` column goes, and the optional note becomes the job's required
-- instructions (core refuses a start without them). A job started before
-- this keeps its note as its instructions.
ALTER TABLE jobs DROP COLUMN tasks;
--;;
ALTER TABLE jobs RENAME COLUMN note TO instructions;
