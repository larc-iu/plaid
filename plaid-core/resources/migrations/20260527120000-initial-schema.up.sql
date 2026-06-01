-- Initial schema for the SQL port of plaid.xtdb2.
-- SQLite-first; portable to Postgres (TEXT for UUIDs, TEXT for JSON,
-- TEXT for ISO-8601 timestamps; INTEGER for ints + booleans).
-- See /home/luke/.claude/plans/sigh-makes-me-sad-drifting-island.md for design rationale.

-- Users
CREATE TABLE users (
  id               TEXT PRIMARY KEY,
  username         TEXT NOT NULL UNIQUE,
  password_hash    TEXT NOT NULL,
  password_changes INTEGER NOT NULL DEFAULT 0,
  is_admin         INTEGER NOT NULL DEFAULT 0 CHECK (is_admin IN (0, 1))
);

-- ============================================================
-- Projects
-- ============================================================
--;;
CREATE TABLE projects (
  id     TEXT PRIMARY KEY,
  name   TEXT NOT NULL,
  config TEXT NOT NULL DEFAULT '{}'
);

-- ACL: a user can have any combination of {reader, writer, maintainer} roles on a project.
--;;
CREATE TABLE project_users (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('reader', 'writer', 'maintainer')),
  PRIMARY KEY (project_id, user_id, role)
);
--;;
CREATE INDEX idx_project_users_user ON project_users(user_id, role);

-- ============================================================
-- Documents
-- ============================================================
--;;
CREATE TABLE documents (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version      INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL,
  modified_at  TEXT NOT NULL
);
--;;
CREATE INDEX idx_documents_project ON documents(project_id);

-- ============================================================
-- Layer hierarchy
-- ============================================================
--;;
CREATE TABLE text_layers (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  order_idx  INTEGER NOT NULL,
  config     TEXT NOT NULL DEFAULT '{}',
  -- order_idx is allocated single-statement via MAX+1 in plaid.sql.text-layer/create
  -- (no read-then-write race) and shifted by the swap dance in shift-layer!.
  -- The shift uses a sentinel of -1 which never collides with the >= 0 range.
  UNIQUE (project_id, order_idx)
);

--;;
CREATE TABLE token_layers (
  id                    TEXT PRIMARY KEY,
  name                  TEXT NOT NULL,
  text_layer_id         TEXT NOT NULL REFERENCES text_layers(id) ON DELETE CASCADE,
  project_id            TEXT NOT NULL, -- denormalized for fast project-id lookup
  overlap_mode          TEXT NOT NULL DEFAULT 'any'
                          CHECK (overlap_mode IN ('any', 'non-overlapping', 'partitioning')),
  parent_token_layer_id TEXT NULL REFERENCES token_layers(id) ON DELETE CASCADE, -- immutable; deleting a parent layer cascades to its descendant token layers
  order_idx             INTEGER NOT NULL,
  config                TEXT NOT NULL DEFAULT '{}',
  -- order_idx allocated single-statement MAX+1; see text_layers comment.
  UNIQUE (text_layer_id, order_idx)
);
--;;
CREATE INDEX idx_token_layers_parent ON token_layers(parent_token_layer_id);

--;;
CREATE TABLE span_layers (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  token_layer_id TEXT NOT NULL REFERENCES token_layers(id) ON DELETE CASCADE,
  project_id     TEXT NOT NULL, -- denormalized
  order_idx      INTEGER NOT NULL,
  config         TEXT NOT NULL DEFAULT '{}',
  -- order_idx allocated single-statement MAX+1; see text_layers comment.
  UNIQUE (token_layer_id, order_idx)
);

--;;
CREATE TABLE relation_layers (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  span_layer_id TEXT NOT NULL REFERENCES span_layers(id) ON DELETE CASCADE,
  project_id    TEXT NOT NULL, -- denormalized
  order_idx     INTEGER NOT NULL,
  config        TEXT NOT NULL DEFAULT '{}',
  -- order_idx allocated single-statement MAX+1; see text_layers comment.
  UNIQUE (span_layer_id, order_idx)
);

-- ============================================================
-- Texts
-- ============================================================
--;;
CREATE TABLE texts (
  id            TEXT PRIMARY KEY,
  body          TEXT NOT NULL,
  document_id   TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  text_layer_id TEXT NOT NULL REFERENCES text_layers(id) ON DELETE CASCADE,
  UNIQUE (document_id, text_layer_id)
);

-- ============================================================
-- Tokens
-- ============================================================
--;;
CREATE TABLE tokens (
  id             TEXT PRIMARY KEY,
  text_id        TEXT NOT NULL REFERENCES texts(id) ON DELETE CASCADE,
  token_layer_id TEXT NOT NULL REFERENCES token_layers(id) ON DELETE CASCADE,
  document_id    TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE, -- denormalized for cascade-by-doc + overlap queries
  begin          INTEGER NOT NULL,
  end_           INTEGER NOT NULL, -- 'end' is reserved-ish; underscore-suffixed for portability
  precedence     INTEGER NULL,
  CHECK (begin <= end_)
);

-- Hot-path indexes for the constraint queries in plaid.xtdb2.constraints.token:
-- overlap checks, containment lookups, range scans, descendant fetches.
--;;
CREATE INDEX idx_tokens_layer_doc_begin ON tokens(token_layer_id, document_id, begin);
--;;
CREATE INDEX idx_tokens_layer_doc_end ON tokens(token_layer_id, document_id, end_);
--;;
CREATE INDEX idx_tokens_text_begin_end ON tokens(text_id, begin, end_);
-- Cascade-by-document scans need a standalone document_id index (the leftmost
-- column of the compound indexes above is token_layer_id, so they don't help
-- a "DELETE all tokens with this document_id" query).
--;;
CREATE INDEX idx_tokens_document ON tokens(document_id);

-- ============================================================
-- Spans (with ordered token list)
-- ============================================================
--;;
CREATE TABLE spans (
  id            TEXT PRIMARY KEY,
  span_layer_id TEXT NOT NULL REFERENCES span_layers(id) ON DELETE CASCADE,
  document_id   TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  value         TEXT NULL -- JSON-encoded scalar (string/number/bool/null)
);
--;;
CREATE INDEX idx_spans_layer_doc ON spans(span_layer_id, document_id);
--;;
CREATE INDEX idx_spans_document ON spans(document_id);

--;;
CREATE TABLE span_tokens (
  span_id   TEXT NOT NULL REFERENCES spans(id) ON DELETE CASCADE,
  token_id  TEXT NOT NULL REFERENCES tokens(id) ON DELETE CASCADE,
  order_idx INTEGER NOT NULL,
  PRIMARY KEY (span_id, order_idx)
);
--;;
CREATE INDEX idx_span_tokens_token ON span_tokens(token_id);

-- ============================================================
-- Relations
-- ============================================================
--;;
CREATE TABLE relations (
  id                TEXT PRIMARY KEY,
  relation_layer_id TEXT NOT NULL REFERENCES relation_layers(id) ON DELETE CASCADE,
  document_id       TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  source_span_id    TEXT NOT NULL REFERENCES spans(id) ON DELETE CASCADE,
  target_span_id    TEXT NOT NULL REFERENCES spans(id) ON DELETE CASCADE,
  value             TEXT NULL -- JSON-encoded scalar
);
--;;
CREATE INDEX idx_relations_layer_doc ON relations(relation_layer_id, document_id);
--;;
CREATE INDEX idx_relations_document ON relations(document_id);
--;;
CREATE INDEX idx_relations_source ON relations(source_span_id);
--;;
CREATE INDEX idx_relations_target ON relations(target_span_id);

-- ============================================================
-- Vocab
-- ============================================================
--;;
CREATE TABLE vocab_layers (
  id     TEXT PRIMARY KEY,
  name   TEXT NOT NULL,
  config TEXT NOT NULL DEFAULT '{}'
);

--;;
CREATE TABLE vocab_maintainers (
  vocab_layer_id TEXT NOT NULL REFERENCES vocab_layers(id) ON DELETE CASCADE,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (vocab_layer_id, user_id)
);
--;;
CREATE INDEX idx_vocab_maintainers_user ON vocab_maintainers(user_id);

--;;
CREATE TABLE project_vocabs (
  project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  vocab_layer_id TEXT NOT NULL REFERENCES vocab_layers(id) ON DELETE CASCADE,
  PRIMARY KEY (project_id, vocab_layer_id)
);
--;;
CREATE INDEX idx_project_vocabs_vocab ON project_vocabs(vocab_layer_id);

--;;
CREATE TABLE vocab_items (
  id             TEXT PRIMARY KEY,
  form           TEXT NOT NULL,
  vocab_layer_id TEXT NOT NULL REFERENCES vocab_layers(id) ON DELETE CASCADE
);
--;;
CREATE INDEX idx_vocab_items_layer ON vocab_items(vocab_layer_id);

--;;
CREATE TABLE vocab_links (
  id            TEXT PRIMARY KEY,
  vocab_item_id TEXT NOT NULL REFERENCES vocab_items(id) ON DELETE CASCADE,
  document_id   TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE
);
--;;
CREATE INDEX idx_vocab_links_item ON vocab_links(vocab_item_id);
--;;
CREATE INDEX idx_vocab_links_document ON vocab_links(document_id);

--;;
CREATE TABLE vocab_link_tokens (
  vocab_link_id TEXT NOT NULL REFERENCES vocab_links(id) ON DELETE CASCADE,
  token_id      TEXT NOT NULL REFERENCES tokens(id) ON DELETE CASCADE,
  order_idx     INTEGER NOT NULL,
  PRIMARY KEY (vocab_link_id, order_idx)
);
--;;
CREATE INDEX idx_vocab_link_tokens_token ON vocab_link_tokens(token_id);

-- ============================================================
-- Entity metadata (replaces the per-entity :*/metadata JSON blob)
-- entity_type is the singular table noun: 'token', 'span', 'relation',
-- 'document', 'text', 'vocab_item', 'vocab_link'.
-- ============================================================
--;;
CREATE TABLE entity_metadata (
  entity_type TEXT NOT NULL,
  entity_id   TEXT NOT NULL,
  key         TEXT NOT NULL,
  value       TEXT NOT NULL,
  PRIMARY KEY (entity_type, entity_id, key)
);

-- ============================================================
-- Audit log
-- ============================================================
-- An "operation" is a logical user action (one row per submit-operations! call).
-- An "audit_write" is a row-level write inside that operation, with pre- and
-- post-image JSON so the log is self-contained enough for future replay.
--
-- Retention policy: KEEP FOREVER pre-ETL. These tables are the canonical
-- change-data-capture stream for the planned OLAP replica (see
-- docs/sql-port-review-2026-05-27.md §8 "Audit log retention policy").
-- audit_writes grows monotonically; disk-space monitoring is operator
-- responsibility today. Do NOT add pruning rules until the OLAP replica
-- is built and has consumed the audit log through a real sync mechanism.
--;;
CREATE TABLE operations (
  id          TEXT PRIMARY KEY,
  op_type     TEXT NOT NULL,
  project_id  TEXT NULL,
  document_id TEXT NULL,
  description TEXT,
  batch_id    TEXT NULL,
  user_id     TEXT NULL REFERENCES users(id),
  user_agent  TEXT,
  ts          TEXT NOT NULL
);
--;;
CREATE INDEX idx_operations_project_ts ON operations(project_id, ts);
--;;
CREATE INDEX idx_operations_document_ts ON operations(document_id, ts);
--;;
CREATE INDEX idx_operations_user_ts ON operations(user_id, ts);
--;;
CREATE INDEX idx_operations_batch ON operations(batch_id);

--;;
CREATE TABLE audit_writes (
  id           TEXT PRIMARY KEY,
  op_id        TEXT NOT NULL REFERENCES operations(id) ON DELETE CASCADE,
  -- seq: ordinal of this write within its op (0-based, incremented by a
  -- per-op counter in plaid.sql.operation/submit-operation*). All rows
  -- in the same op share the same `ts`, so `seq` is the load-bearing
  -- column for replay-order determinism and for ETL tie-break when
  -- reading audit history.
  seq          INTEGER NOT NULL,
  target_table TEXT NOT NULL,
  target_id    TEXT NOT NULL,
  -- 'insert' / 'update' / 'delete' are the row-level writes captured by
  -- the audit helpers in plaid.sql.common.
  -- 'doc-version-bump' is a sentinel for the post-body documents.version
  -- bump in plaid.sql.operation/bump-document-version!. ETL replayers
  -- that track "did the document body change?" should IGNORE rows with
  -- this change_type (every annotation write would otherwise look like
  -- a doc edit, since every op touching the doc bumps its version), but
  -- still apply them for replay determinism — the pre/post images carry
  -- the version + modified_at transition.
  change_type  TEXT NOT NULL CHECK (change_type IN ('insert', 'update', 'delete', 'doc-version-bump')),
  pre_image    TEXT NULL,
  post_image   TEXT NULL,
  ts           TEXT NOT NULL,
  -- (op_id, seq) is both the ETL-replay seek order AND a uniqueness
  -- guard against double-counting from a buggy counter. UNIQUE auto-
  -- creates an index that supersedes the old (non-unique) op_id index.
  UNIQUE (op_id, seq)
);
--;;
-- ETL change-tracking on a specific entity sorts by (ts DESC, seq DESC)
-- so within-op tie-break is deterministic when multiple writes hit the
-- same row inside one op.
CREATE INDEX idx_audit_writes_target ON audit_writes(target_table, target_id, ts DESC, seq DESC);
--;;
CREATE INDEX idx_audit_writes_ts ON audit_writes(ts);
