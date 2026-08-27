-- Profile pictures (#user-avatars).
--
-- Deliberately split across two places:
--
--   * `users.avatar_hash`, a SHA-256 hex digest of the stored bytes, or NULL
--     for "no picture". It lives on the user row so that every read of a user
--     answers "has a picture, and which one" without a join, and so that a
--     change is visible in `audit_writes` (which persists the FULL post-image
--     of any touched row) as a 64-character string.
--
--   * `user_avatars.bytes`, the pixels, in their own table, written OUTSIDE
--     the audited write helpers in `plaid.sql.common`. A BLOB on `users` would
--     copy the entire picture into the audit log on every unrelated username
--     or password change.
--
-- In SQLite rather than on disk (where document media lives) because
-- `plaid.server.backup` snapshots the database only: an on-disk avatar
-- directory would sit outside every nightly backup and would need its own
-- orphan sweep, the way `sweep-orphaned-media!` does for media. Avatars are
-- normalized to one small square before storage, so keeping them inline costs
-- little and buys backup coverage plus FK-cascade cleanup for free.
ALTER TABLE users ADD COLUMN avatar_hash TEXT NULL;
--;;
CREATE TABLE user_avatars (
  user_id      TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  content_type TEXT NOT NULL,          -- image/png or image/jpeg (server-produced)
  bytes        BLOB NOT NULL,
  updated_at   TEXT NOT NULL
);
