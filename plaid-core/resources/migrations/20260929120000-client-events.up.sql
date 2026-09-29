-- Client events (#research telemetry, 2026-09-29).
--
-- A short record of what a person did with a machine suggestion in an app:
-- a suggestion shown, adopted or dismissed, an assistant plan card opened.
-- The set of event types is closed and checked by the server
-- (`plaid.sql.client-event/types`). Rows are written only for a project
-- whose `config.plaid.research.telemetry` is true.
--
-- Like comments and user data this sits OUTSIDE the audit log: a write is
-- not an operation, it has no audit row, it bumps no document version and
-- nothing about it is time-travelable. It is not part of the linguistic
-- record, only a note of how the record came to be made.
--
-- `id` is an integer rowid, so the natural order is arrival order and the
-- list endpoint pages by it. `ts` is stamped by the server, `client_ts` is
-- the browser's own clock when the event happened (events are sent in
-- batches, seconds later).
--
-- `project_id` cascades: a deleted project takes its events with it.
-- `document_id` deliberately has NO foreign key. Deleting one document is
-- an audited, time-travelable operation, and an event about it keeps its id
-- so it can still be joined to that document's history. The server checks
-- on insert that the document belongs to the project.
--
-- `user_id` has no ON DELETE clause, matching `comments.author_id`: users
-- are not deletable.
CREATE TABLE client_events (
  id          INTEGER PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  document_id TEXT NULL,
  user_id     TEXT NOT NULL REFERENCES users(id),
  type        TEXT NOT NULL,
  target_id   TEXT NULL,
  data        TEXT NULL,                  -- JSON object, stored verbatim
  client_ts   TEXT NULL,
  ts          TEXT NOT NULL
);
--;;
-- The read: one project's events in arrival order (the rowid rides every
-- index, so this is (project_id, id)).
CREATE INDEX idx_client_events_project ON client_events(project_id);
--;;
-- The same read narrowed to one or more types.
CREATE INDEX idx_client_events_project_type ON client_events(project_id, type);
