-- Guidelines (#guidelines).
--
-- A project's own annotation manual: a flat list of short Markdown documents
-- stating the conventions the people on the project have agreed to. "Loanwords
-- are not segmented", "free translations are idiomatic, not literal". Written
-- by the team, read by the team, and read by the assistant before it proposes
-- anything.
--
-- Contrast tagsets, which govern the VALUE of one field and live in project
-- config. A guideline is prose about how to annotate, and prose does not
-- belong in a config blob that rides every project read.
--
-- Writes ARE audited (through `plaid.sql.operation/submit-operation!`), unlike
-- comments. A guideline is governance, not chatter: "who changed the ergative
-- rule, and when" is a question someone will ask. Note what that does and does
-- not buy. It buys the audit feed, the SSE announce, and pre/post images. It
-- does NOT buy `?as-of=` reads or restore, both of which are document-scoped
-- by construction (`plaid.history.read` folds on `audit_writes.document_id`).
--
-- Guideline ops carry `:document nil`, like every layer write, so no document
-- version moves and no reader's OCC token is invalidated by one.
--
-- `title` is the handle: the assistant asks for a guideline BY TITLE, never by
-- id. It is deliberately NOT unique, though. Enforcing that would refuse a save
-- after someone had written a whole document, to prevent a confusion that is
-- mild (two rows named the same in a list they own) and that the assistant can
-- absorb on its own (read_guideline answers with every match). The editor warns
-- while the title is being typed instead, and saves either way.
CREATE TABLE guidelines (
  id         TEXT    NOT NULL PRIMARY KEY,
  project_id TEXT    NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title      TEXT    NOT NULL,
  summary    TEXT    NOT NULL,
  body       TEXT    NOT NULL DEFAULT '',
  pinned     INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
  created_at TEXT    NOT NULL,
  updated_at TEXT    NOT NULL
);
--;;
-- The list read, and the keyset page order. Ordered by title rather than by
-- `pinned` first because `plaid.sql.pagination/paginate` keysets over NOT NULL
-- TEXT columns compared as strings, which an INTEGER flag cannot be. Pinned
-- rows are grouped by whoever is displaying them.
CREATE INDEX idx_guidelines_project ON guidelines(project_id, title, id);
