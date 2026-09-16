-- Restoring the column cannot restore what was in it. NOT NULL needs a
-- default, and every row comes back with an empty summary.
ALTER TABLE guidelines ADD COLUMN summary TEXT NOT NULL DEFAULT '';
