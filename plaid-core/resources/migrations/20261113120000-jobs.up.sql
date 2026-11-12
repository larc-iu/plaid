-- Assistant jobs (2026-11-12): unattended glossing a writer starts and a
-- worker process, run by an admin, carries out one job at a time.
--
-- Like client events and service claims these sit OUTSIDE the audit log. A
-- job is a record of how work was done, not part of the linguistic record:
-- creating, claiming, cancelling or finishing one is no operation, has no
-- audit row and bumps no document. What a job writes into documents goes
-- through the ordinary routes, under the starter's name, and is audited
-- there. See `plaid.sql.job`.
--
-- `project_id` cascades: a deleted project takes its jobs, their document
-- rows and their decisions with it. `started_by` has no ON DELETE clause,
-- matching `comments.author_id`: users are not deletable.
CREATE TABLE jobs (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  app              TEXT NOT NULL,
  tasks            TEXT NOT NULL,          -- JSON array of task names
  note             TEXT NULL,
  started_by       TEXT NOT NULL REFERENCES users(id),
  state            TEXT NOT NULL,
  phase            TEXT NULL,
  reason           TEXT NULL,
  message          TEXT NULL,
  waiting_for      TEXT NULL,
  current_document TEXT NULL,
  cancelled_by     TEXT NULL,
  worker_id        TEXT NULL,
  worker_user      TEXT NULL,
  model            TEXT NULL,
  created_at       TEXT NOT NULL,
  started_at       TEXT NULL,
  heartbeat_at     TEXT NULL,
  finished_at      TEXT NULL,
  report           TEXT NULL               -- JSON object, stored verbatim
);
--;;
-- A project's jobs, newest first, and its active one.
CREATE INDEX idx_jobs_project ON jobs(project_id, created_at);
--;;
-- The claim: active jobs across the server, oldest first.
CREATE INDEX idx_jobs_state ON jobs(state, created_at);
--;;
-- One row per document of a job. `document_id` deliberately has NO foreign
-- key: a document deleted while the job runs keeps its row, as a client
-- event about it keeps its id.
CREATE TABLE job_documents (
  job_id          TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  document_id     TEXT NOT NULL,
  position        INTEGER NOT NULL,
  state           TEXT NOT NULL,
  sentences       INTEGER NULL,
  targets         INTEGER NULL,
  done            INTEGER NULL,
  last_sentence   TEXT NULL,
  defers          INTEGER NOT NULL DEFAULT 0,
  counts          TEXT NOT NULL DEFAULT '{}',
  skipped         TEXT NOT NULL DEFAULT '[]',
  gloss_group     TEXT NULL,
  harmonize_group TEXT NULL,
  updated_at      TEXT NOT NULL,
  PRIMARY KEY (job_id, document_id)
);
--;;
-- How a job analysed each form, one row per distinct analysis, with the
-- number of words written that way. `form` and `analysis` are the worker's
-- strings, stored as sent and never read inside.
CREATE TABLE job_decisions (
  job_id         TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  form           TEXT NOT NULL,
  key            TEXT NOT NULL,
  analysis       TEXT NOT NULL,
  count          INTEGER NOT NULL,
  first_document TEXT NULL,
  first_sentence TEXT NULL,
  PRIMARY KEY (job_id, form, key)
);
