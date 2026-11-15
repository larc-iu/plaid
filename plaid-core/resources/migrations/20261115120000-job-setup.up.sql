-- What a job was set up with (2026-11-15): a JSON object the app sends when
-- the job starts, stored verbatim and returned on every read of the job. Set
-- only at the start, never changed. Core reads none of its keys: igt keeps
-- there what the job may fill, whether it may edit the text and the
-- assistant conversation that set it up. NULL for a job started with none,
-- and for every job from before this column.
ALTER TABLE jobs ADD COLUMN setup TEXT NULL;
