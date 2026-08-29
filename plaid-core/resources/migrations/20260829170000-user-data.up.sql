-- Private per-user key/value storage (#user-data).
--
-- A small JSON document store scoped to one user: `key` is chosen by the
-- client (apps namespace their keys, e.g. `igt:assistant:<project>:...`),
-- `value` is any JSON the client wants to keep across devices and sessions
-- (assistant conversations, drafts, UI preferences). Readable and writable
-- only by the owning user or an admin. NOT annotation data: writes are not
-- audited, and rows go with the user (ON DELETE CASCADE).
CREATE TABLE user_data (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key        TEXT NOT NULL,
  value      TEXT NOT NULL,                 -- JSON, stored verbatim
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, key)
);
