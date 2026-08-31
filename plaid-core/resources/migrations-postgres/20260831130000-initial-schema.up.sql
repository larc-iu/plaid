-- Postgres baseline schema.
--
-- WHY THIS IS ONE FILE AND NOT 36
-- ================================
-- `resources/migrations` is the SQLite history: 36 migrations accumulated
-- since the XTDB port, several of which are written in SQLite-only dialect
-- (json_extract, instr, BLOB, datetime('now')). There has never been a
-- Postgres database in the wild, so there is nothing to replay that history
-- FOR. This file is the squashed equivalent of applying all of them,
-- verified against `sqlite3 .schema` on a freshly-migrated SQLite file.
--
-- Every migration added from here on needs a file in BOTH directories.
-- Most are byte-identical (CREATE TABLE / CREATE INDEX / ALTER TABLE ADD
-- COLUMN are portable as written); watch for the four things that are not:
-- BLOB (-> BYTEA), json_extract (-> ::jsonb ->>), instr (-> strpos),
-- datetime('now') (-> now()::text).
--
-- COLLATE "C" ON EVERY TEXT COLUMN
-- =================================
-- Not decoration. SQLite's TEXT comparison is BINARY (byte order); Postgres
-- uses the database's collation, which is typically a locale like en_US.utf8
-- and orders "linguistically" (case-insensitive-ish, punctuation-ignoring).
-- Three things in this codebase depend on byte order:
--
--   * keyset pagination (plaid.sql.pagination) seeks with `WHERE key > ?`
--     against an ORDER BY on the same column. Self-consistent under any
--     collation, but the PAGE BOUNDARIES would differ between backends.
--   * the history cursor and as-of reconstruction compare fixed-width
--     ISO-8601 `ts` strings as text (plaid.sql.common/iso-instant-9).
--   * `plaid.sql.pagination/paginate-coll` sorts IN JAVA (String compare =
--     UTF-16 code-unit order) for the in-memory list endpoints, and the two
--     paginators are expected to agree.
--
-- Declaring the columns `COLLATE "C"` pins byte order regardless of how the
-- operator created the database, so ordering is identical on both backends.
-- Equality is unaffected (both collations are deterministic), and "C" is
-- the collation Postgres can plan LIKE prefix scans against.
--
-- IDENTIFIERS ARE TEXT, NOT uuid
-- ==============================
-- Same reasoning as the SQLite schema: `users.id` is an email address and
-- `audit_writes.target_id` holds whichever identity kind its target_table
-- uses. Booleans are INTEGER 0/1 for the same reason: one storage shape and
-- one set of mappers (plaid.sql.common/coerce-id-cols and friends) across
-- both backends.

CREATE TABLE users (
  id               TEXT COLLATE "C" PRIMARY KEY,
  -- Vestigial: equal to `id`, unexposed, kept only because it carries a
  -- UNIQUE index the SQLite side could not drop without a table rebuild.
  username         TEXT COLLATE "C" NOT NULL UNIQUE,
  password_hash    TEXT COLLATE "C" NOT NULL,
  password_changes INTEGER NOT NULL DEFAULT 0,
  is_admin         INTEGER NOT NULL DEFAULT 0 CHECK (is_admin IN (0, 1)),
  deactivated_at   TEXT COLLATE "C" NULL,
  avatar_hash      TEXT COLLATE "C" NULL,
  display_name     TEXT COLLATE "C" NOT NULL DEFAULT ''
);
--;;
-- Backs the roster's ORDER BY (display_name, id): display names are not
-- unique, so the id rides along as the keyset tiebreaker.
CREATE INDEX idx_users_display_name_id ON users(display_name, id);
--;;
CREATE TABLE user_avatars (
  user_id      TEXT COLLATE "C" PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  content_type TEXT COLLATE "C" NOT NULL,   -- image/png or image/jpeg (server-produced)
  bytes        BYTEA NOT NULL,              -- SQLite spells this BLOB
  updated_at   TEXT COLLATE "C" NOT NULL
);
--;;
CREATE TABLE user_data (
  user_id    TEXT COLLATE "C" NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key        TEXT COLLATE "C" NOT NULL,
  value      TEXT COLLATE "C" NOT NULL,     -- JSON, stored verbatim
  updated_at TEXT COLLATE "C" NOT NULL,
  PRIMARY KEY (user_id, key)
);

-- ============================================================
-- Projects
-- ============================================================
--;;
CREATE TABLE projects (
  id     TEXT COLLATE "C" PRIMARY KEY,
  name   TEXT COLLATE "C" NOT NULL,
  config TEXT COLLATE "C" NOT NULL DEFAULT '{}'
);
--;;
-- ACL: a user can have any combination of {reader, writer, maintainer} roles on a project.
CREATE TABLE project_users (
  project_id TEXT COLLATE "C" NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id    TEXT COLLATE "C" NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       TEXT COLLATE "C" NOT NULL CHECK (role IN ('reader', 'writer', 'maintainer')),
  PRIMARY KEY (project_id, user_id, role)
);
--;;
CREATE INDEX idx_project_users_user ON project_users(user_id, role);

-- ============================================================
-- Documents
-- ============================================================
--;;
CREATE TABLE documents (
  id           TEXT COLLATE "C" PRIMARY KEY,
  name         TEXT COLLATE "C" NOT NULL,
  project_id   TEXT COLLATE "C" NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version      INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT COLLATE "C" NOT NULL,
  modified_at  TEXT COLLATE "C" NOT NULL
);
--;;
CREATE INDEX idx_documents_project ON documents(project_id);
--;;
CREATE INDEX idx_documents_project_name_id ON documents(project_id, name, id);

-- ============================================================
-- Layer hierarchy
-- ============================================================
--;;
CREATE TABLE text_layers (
  id         TEXT COLLATE "C" PRIMARY KEY,
  name       TEXT COLLATE "C" NOT NULL,
  project_id TEXT COLLATE "C" NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  order_idx  INTEGER NOT NULL,
  config     TEXT COLLATE "C" NOT NULL DEFAULT '{}',
  -- order_idx is allocated single-statement via MAX+1 in plaid.sql.text-layer/create
  -- (no read-then-write race) and shifted by the swap dance in shift-layer!.
  -- The shift uses a sentinel of -1 which never collides with the >= 0 range.
  UNIQUE (project_id, order_idx)
);
--;;
CREATE TABLE token_layers (
  id                    TEXT COLLATE "C" PRIMARY KEY,
  name                  TEXT COLLATE "C" NOT NULL,
  text_layer_id         TEXT COLLATE "C" NOT NULL REFERENCES text_layers(id) ON DELETE CASCADE,
  project_id            TEXT COLLATE "C" NOT NULL, -- denormalized for fast project-id lookup
  overlap_mode          TEXT COLLATE "C" NOT NULL DEFAULT 'any'
                          CHECK (overlap_mode IN ('any', 'non-overlapping', 'partitioning')),
  parent_token_layer_id TEXT COLLATE "C" NULL REFERENCES token_layers(id) ON DELETE CASCADE, -- immutable; deleting a parent layer cascades to its descendant token layers
  order_idx             INTEGER NOT NULL,
  config                TEXT COLLATE "C" NOT NULL DEFAULT '{}',
  -- order_idx allocated single-statement MAX+1; see text_layers comment.
  UNIQUE (text_layer_id, order_idx)
);
--;;
CREATE INDEX idx_token_layers_parent ON token_layers(parent_token_layer_id);
--;;
CREATE TABLE span_layers (
  id             TEXT COLLATE "C" PRIMARY KEY,
  name           TEXT COLLATE "C" NOT NULL,
  token_layer_id TEXT COLLATE "C" NOT NULL REFERENCES token_layers(id) ON DELETE CASCADE,
  project_id     TEXT COLLATE "C" NOT NULL, -- denormalized
  order_idx      INTEGER NOT NULL,
  config         TEXT COLLATE "C" NOT NULL DEFAULT '{}',
  -- order_idx allocated single-statement MAX+1; see text_layers comment.
  UNIQUE (token_layer_id, order_idx)
);
--;;
CREATE TABLE relation_layers (
  id            TEXT COLLATE "C" PRIMARY KEY,
  name          TEXT COLLATE "C" NOT NULL,
  span_layer_id TEXT COLLATE "C" NOT NULL REFERENCES span_layers(id) ON DELETE CASCADE,
  project_id    TEXT COLLATE "C" NOT NULL, -- denormalized
  order_idx     INTEGER NOT NULL,
  config        TEXT COLLATE "C" NOT NULL DEFAULT '{}',
  -- order_idx allocated single-statement MAX+1; see text_layers comment.
  UNIQUE (span_layer_id, order_idx)
);

-- ============================================================
-- Annotation data
-- ============================================================
--;;
CREATE TABLE texts (
  id            TEXT COLLATE "C" PRIMARY KEY,
  body          TEXT COLLATE "C" NOT NULL,
  document_id   TEXT COLLATE "C" NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  text_layer_id TEXT COLLATE "C" NOT NULL REFERENCES text_layers(id) ON DELETE CASCADE,
  UNIQUE (document_id, text_layer_id)
);
--;;
CREATE TABLE tokens (
  id             TEXT COLLATE "C" PRIMARY KEY,
  text_id        TEXT COLLATE "C" NOT NULL REFERENCES texts(id) ON DELETE CASCADE,
  token_layer_id TEXT COLLATE "C" NOT NULL REFERENCES token_layers(id) ON DELETE CASCADE,
  document_id    TEXT COLLATE "C" NOT NULL REFERENCES documents(id) ON DELETE CASCADE, -- denormalized for cascade-by-doc + overlap queries
  -- begin/end_ are Unicode CODE POINT offsets into texts.body, not UTF-16
  -- units (plaid.util.codepoint). `end` is reserved-ish; underscore-suffixed.
  begin          INTEGER NOT NULL,
  end_           INTEGER NOT NULL,
  precedence     INTEGER NULL,
  CHECK (begin <= end_)
);
--;;
CREATE INDEX idx_tokens_layer_doc_begin ON tokens(token_layer_id, document_id, begin);
--;;
CREATE INDEX idx_tokens_layer_doc_end ON tokens(token_layer_id, document_id, end_);
--;;
CREATE INDEX idx_tokens_text_begin_end ON tokens(text_id, begin, end_);
--;;
CREATE INDEX idx_tokens_document ON tokens(document_id);
--;;
CREATE TABLE spans (
  id            TEXT COLLATE "C" PRIMARY KEY,
  span_layer_id TEXT COLLATE "C" NOT NULL REFERENCES span_layers(id) ON DELETE CASCADE,
  document_id   TEXT COLLATE "C" NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  value         TEXT COLLATE "C" NULL -- JSON-encoded scalar (string/number/bool/null)
);
--;;
CREATE INDEX idx_spans_layer_doc ON spans(span_layer_id, document_id);
--;;
CREATE INDEX idx_spans_document ON spans(document_id);
--;;
CREATE INDEX idx_spans_layer_value ON spans(span_layer_id, value);
--;;
CREATE TABLE span_tokens (
  span_id   TEXT COLLATE "C" NOT NULL REFERENCES spans(id) ON DELETE CASCADE,
  token_id  TEXT COLLATE "C" NOT NULL REFERENCES tokens(id) ON DELETE CASCADE,
  order_idx INTEGER NOT NULL,
  PRIMARY KEY (span_id, order_idx)
);
--;;
CREATE INDEX idx_span_tokens_token ON span_tokens(token_id);
--;;
CREATE TABLE relations (
  id                TEXT COLLATE "C" PRIMARY KEY,
  relation_layer_id TEXT COLLATE "C" NOT NULL REFERENCES relation_layers(id) ON DELETE CASCADE,
  document_id       TEXT COLLATE "C" NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  source_span_id    TEXT COLLATE "C" NOT NULL REFERENCES spans(id) ON DELETE CASCADE,
  target_span_id    TEXT COLLATE "C" NOT NULL REFERENCES spans(id) ON DELETE CASCADE,
  value             TEXT COLLATE "C" NULL -- JSON-encoded scalar
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
-- Vocabularies
-- ============================================================
--;;
CREATE TABLE vocab_layers (
  id          TEXT COLLATE "C" PRIMARY KEY,
  name        TEXT COLLATE "C" NOT NULL,
  config      TEXT COLLATE "C" NOT NULL DEFAULT '{}',
  created_at  TEXT COLLATE "C" NULL,
  modified_at TEXT COLLATE "C" NULL
);
--;;
CREATE TABLE vocab_maintainers (
  vocab_layer_id TEXT COLLATE "C" NOT NULL REFERENCES vocab_layers(id) ON DELETE CASCADE,
  user_id        TEXT COLLATE "C" NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (vocab_layer_id, user_id)
);
--;;
CREATE INDEX idx_vocab_maintainers_user ON vocab_maintainers(user_id);
--;;
CREATE TABLE project_vocabs (
  project_id     TEXT COLLATE "C" NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  vocab_layer_id TEXT COLLATE "C" NOT NULL REFERENCES vocab_layers(id) ON DELETE CASCADE,
  PRIMARY KEY (project_id, vocab_layer_id)
);
--;;
CREATE INDEX idx_project_vocabs_vocab ON project_vocabs(vocab_layer_id);
--;;
CREATE TABLE vocab_items (
  id             TEXT COLLATE "C" PRIMARY KEY,
  form           TEXT COLLATE "C" NOT NULL,
  vocab_layer_id TEXT COLLATE "C" NOT NULL REFERENCES vocab_layers(id) ON DELETE CASCADE
);
--;;
CREATE INDEX idx_vocab_items_layer ON vocab_items(vocab_layer_id);
--;;
CREATE TABLE vocab_links (
  id            TEXT COLLATE "C" PRIMARY KEY,
  vocab_item_id TEXT COLLATE "C" NOT NULL REFERENCES vocab_items(id) ON DELETE CASCADE,
  document_id   TEXT COLLATE "C" NOT NULL REFERENCES documents(id) ON DELETE CASCADE
);
--;;
CREATE INDEX idx_vocab_links_item ON vocab_links(vocab_item_id);
--;;
CREATE INDEX idx_vocab_links_document ON vocab_links(document_id);
--;;
CREATE TABLE vocab_link_tokens (
  vocab_link_id TEXT COLLATE "C" NOT NULL REFERENCES vocab_links(id) ON DELETE CASCADE,
  token_id      TEXT COLLATE "C" NOT NULL REFERENCES tokens(id) ON DELETE CASCADE,
  order_idx     INTEGER NOT NULL,
  PRIMARY KEY (vocab_link_id, order_idx)
);
--;;
CREATE INDEX idx_vocab_link_tokens_token ON vocab_link_tokens(token_id);

-- ============================================================
-- Metadata (wide-narrow KV over every annotatable entity)
-- ============================================================
--;;
CREATE TABLE entity_metadata (
  entity_type TEXT COLLATE "C" NOT NULL,
  entity_id   TEXT COLLATE "C" NOT NULL,
  key         TEXT COLLATE "C" NOT NULL,
  value       TEXT COLLATE "C" NOT NULL,
  PRIMARY KEY (entity_type, entity_id, key)
);

-- ============================================================
-- Comments
-- ============================================================
--;;
CREATE TABLE comments (
  id          TEXT COLLATE "C" PRIMARY KEY,
  project_id  TEXT COLLATE "C" NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  document_id TEXT COLLATE "C" NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  entity_type TEXT COLLATE "C" NOT NULL,
  entity_id   TEXT COLLATE "C" NOT NULL,
  author_id   TEXT COLLATE "C" NOT NULL REFERENCES users(id),
  body        TEXT COLLATE "C" NOT NULL,
  created_at  TEXT COLLATE "C" NOT NULL,
  updated_at  TEXT COLLATE "C" NOT NULL
);
--;;
CREATE INDEX idx_comments_entity ON comments(entity_type, entity_id, created_at, id);
--;;
CREATE INDEX idx_comments_document ON comments(document_id, created_at, id);
--;;
CREATE INDEX idx_comments_project ON comments(project_id, created_at, id);

-- ============================================================
-- Invites + password resets
-- ============================================================
--;;
-- One table, two kinds, discriminated by `target_user_id`: NULL means a
-- signup invite (may grant admin and/or a project role), non-NULL means a
-- single-use password reset for that user, which grants nothing. Codes are
-- stored as SHA-256 hex, not bcrypt, because they are high-entropy
-- server-minted secrets and a slow KDF buys nothing.
CREATE TABLE invites (
  id             TEXT COLLATE "C" PRIMARY KEY,                 -- UUIDv7
  code_hash      TEXT COLLATE "C" NOT NULL UNIQUE,             -- SHA-256 hex of the plaintext code
  created_by     TEXT COLLATE "C" NOT NULL REFERENCES users(id),
  created_at     TEXT COLLATE "C" NOT NULL,
  expires_at     TEXT COLLATE "C" NOT NULL,                    -- ISO instant; always set (no immortal invites)
  max_uses       INTEGER NOT NULL DEFAULT 1 CHECK (max_uses >= 1),
  uses           INTEGER NOT NULL DEFAULT 0 CHECK (uses >= 0),
  revoked_at     TEXT COLLATE "C" NULL,                        -- soft-revoke; non-null => dead
  note           TEXT COLLATE "C" NULL,                        -- human label, e.g. "Fall 2026 field methods"

  -- Grants applied at redemption. All NULL/0 for a password reset.
  target_user_id TEXT COLLATE "C" NULL REFERENCES users(id),   -- non-null => password reset
  grant_admin    INTEGER NOT NULL DEFAULT 0 CHECK (grant_admin IN (0, 1)),
  project_id     TEXT COLLATE "C" NULL REFERENCES projects(id) ON DELETE CASCADE,
  project_role   TEXT COLLATE "C" NULL CHECK (project_role IN ('reader', 'writer', 'maintainer')),

  -- A project grant is a pair: both columns or neither.
  CHECK ((project_id IS NULL) = (project_role IS NULL)),
  -- A password reset targets exactly one user once, and grants nothing:
  -- re-granting roles on a reset would let a reset link silently change a
  -- user's authority.
  CHECK (target_user_id IS NULL
         OR (max_uses = 1 AND grant_admin = 0 AND project_id IS NULL))
);
--;;
CREATE UNIQUE INDEX idx_invites_code_hash ON invites(code_hash);
--;;
CREATE INDEX idx_invites_creator ON invites(created_by, created_at, id);
--;;
CREATE INDEX idx_invites_project ON invites(project_id, created_at, id);

-- ============================================================
-- Audit log
-- ============================================================
--;;
CREATE TABLE api_tokens (
  id           TEXT COLLATE "C" PRIMARY KEY,   -- UUID; also the :token/id JWT claim
  user_id      TEXT COLLATE "C" NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT COLLATE "C" NOT NULL,
  created_at   TEXT COLLATE "C" NOT NULL,
  last_used_at TEXT COLLATE "C" NULL,
  revoked_at   TEXT COLLATE "C" NULL           -- soft-revoke; non-null => dead
);
--;;
CREATE INDEX idx_api_tokens_user ON api_tokens(user_id);
--;;
CREATE INDEX idx_api_tokens_user_created_id ON api_tokens(user_id, created_at, id);
--;;
CREATE TABLE operation_groups (
  id         TEXT COLLATE "C" PRIMARY KEY,
  message    TEXT COLLATE "C" NULL,
  user_id    TEXT COLLATE "C" NULL,
  created_at TEXT COLLATE "C" NOT NULL
);
--;;
CREATE TABLE operations (
  id          TEXT COLLATE "C" PRIMARY KEY,
  op_type     TEXT COLLATE "C" NOT NULL,
  project_id  TEXT COLLATE "C" NULL,
  document_id TEXT COLLATE "C" NULL,
  description TEXT COLLATE "C",
  batch_id    TEXT COLLATE "C" NULL,
  user_id     TEXT COLLATE "C" NULL REFERENCES users(id),
  -- Strictly monotonic and stamped INSIDE the write tx, so (ts, seq) is the
  -- total commit order as-of reconstruction depends on. See
  -- plaid.sql.common/next-monotonic-ts!.
  ts          TEXT COLLATE "C" NOT NULL,
  token_id    TEXT COLLATE "C" NULL REFERENCES api_tokens(id),
  group_id    TEXT COLLATE "C" NULL
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
CREATE INDEX idx_operations_token ON operations(token_id);
--;;
CREATE INDEX idx_operations_group ON operations(group_id);
--;;
CREATE TABLE audit_writes (
  id           TEXT COLLATE "C" PRIMARY KEY,
  op_id        TEXT COLLATE "C" NOT NULL REFERENCES operations(id) ON DELETE CASCADE,
  -- seq: ordinal of this write within its op (0-based, incremented by a
  -- per-op counter in plaid.sql.operation/submit-operation*). All rows
  -- in the same op share the same `ts`, so `seq` is the load-bearing
  -- column for replay-order determinism and for ETL tie-break when
  -- reading audit history.
  seq          INTEGER NOT NULL,
  target_table TEXT COLLATE "C" NOT NULL,
  target_id    TEXT COLLATE "C" NOT NULL,
  -- 'insert' / 'update' / 'delete' are the row-level writes captured by
  -- the audit helpers in plaid.sql.common.
  -- 'doc-version-bump' is a sentinel for the post-body documents.version
  -- bump in plaid.sql.operation/bump-document-version!. ETL replayers
  -- that track "did the document body change?" should IGNORE rows with
  -- this change_type (every annotation write would otherwise look like
  -- a doc edit, since every op touching the doc bumps its version), but
  -- still apply them for replay determinism, since the images carry
  -- the version + modified_at transition.
  change_type  TEXT COLLATE "C" NOT NULL CHECK (change_type IN ('insert', 'update', 'delete', 'doc-version-bump')),
  -- Post-image only: pre-images have not been persisted since 2026-06-16.
  post_image   TEXT COLLATE "C" NULL,
  ts           TEXT COLLATE "C" NOT NULL,
  -- Denormalized from the row's OWN image, not from operations.document_id
  -- (which is NULL for multi-document cascade ops). This is what ?as-of=
  -- reconstruction scopes by.
  document_id  TEXT COLLATE "C" NULL,
  -- (op_id, seq) is both the ETL-replay seek order AND a uniqueness
  -- guard against double-counting from a buggy counter.
  UNIQUE (op_id, seq)
);
--;;
CREATE INDEX idx_audit_writes_target ON audit_writes(target_table, target_id, ts DESC, seq DESC);
--;;
CREATE INDEX idx_audit_writes_ts ON audit_writes(ts);
--;;
CREATE INDEX idx_audit_writes_document_ts ON audit_writes (document_id, ts, seq);
--;;
CREATE TABLE audit_retention (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  pruned_below_ts TEXT COLLATE "C" NOT NULL,
  pruned_at       TEXT COLLATE "C" NOT NULL
);

-- ============================================================
-- Service registry + one-time data migrations
-- ============================================================
--;;
CREATE TABLE seen_services (
  project_id    TEXT COLLATE "C" NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  service_id    TEXT COLLATE "C" NOT NULL,
  service_name  TEXT COLLATE "C",
  description   TEXT COLLATE "C",
  extras        TEXT COLLATE "C",
  first_seen_at TEXT COLLATE "C" NOT NULL,
  last_seen_at  TEXT COLLATE "C" NOT NULL,
  PRIMARY KEY (project_id, service_id)
);
--;;
-- Tracking table for one-time, Clojure-driven DATA migrations (distinct from
-- `schema_migrations`, which migratus owns). A fresh Postgres database has no
-- pre-code-point-offset data to convert, so this starts and stays empty here.
-- It exists so plaid.migrate.codepoint-offsets has the same table on both
-- backends. SQLite spells the default `datetime('now')`.
CREATE TABLE data_migrations (
  id          TEXT COLLATE "C" PRIMARY KEY,
  applied_at  TEXT COLLATE "C" NOT NULL DEFAULT (now()::text)
);
