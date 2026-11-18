-- How many times a job was taken up again after its worker stopped (its
-- lease lapsed) (2026-11-18, S3-3): core fails a job taken up `resumes-max`
-- times so a job that crashes its worker at the same point cannot hold the
-- one job slot for ever. 0 for every job from before this column.
ALTER TABLE jobs ADD COLUMN resumes INTEGER NOT NULL DEFAULT 0;
