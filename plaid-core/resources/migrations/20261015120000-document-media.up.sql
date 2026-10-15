-- A recording's length (2026-10-15), read from its header when it is
-- uploaded (`plaid.media.duration`), so every client reads one number
-- instead of fetching the file. A row only for a length that was read: a
-- format whose header is not read here (WebM, Ogg) has none, and its
-- length is unknown.
--
-- Its own table, written outside the audited write helpers, like
-- `user_avatars`: the recording itself lives on disk and is not versioned,
-- so its length is not either. On `documents` it would ride in the full
-- post-image of every version bump in `audit_writes`, and a history read
-- or restore would then name a length for a file that is no longer there.
-- Removed with its document by the FK cascade.
CREATE TABLE document_media (
  document_id  TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  duration     REAL NOT NULL
);
