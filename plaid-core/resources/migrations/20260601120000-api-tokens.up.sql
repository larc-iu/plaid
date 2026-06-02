-- Named per-user API tokens (#named-tokens).
--
-- A user can mint one or more named API tokens (e.g. "Stanza Parser",
-- "CI bot"), each a distinct, revocable credential affiliated with that
-- user. The token itself is a signed JWT carrying a `:token/id` claim equal
-- to `api_tokens.id`; the row here is the server-side reference used for
-- revocation + audit attribution. The signed JWT is NEVER stored.
--
-- Revocation is SOFT (`revoked_at`): `operations.token_id` FKs into this
-- table, so hard-deleting a token that has historical ops would either
-- violate the FK or (with ON DELETE SET NULL) erase the attribution name.
-- Keeping the row forever means the audit log can always resolve which
-- named credential performed an action.
CREATE TABLE api_tokens (
  id           TEXT PRIMARY KEY,                 -- UUID; also the :token/id JWT claim
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  last_used_at TEXT NULL,
  revoked_at   TEXT NULL                         -- soft-revoke; non-null => dead
);
--;;
CREATE INDEX idx_api_tokens_user ON api_tokens(user_id);
--;;
-- Server-authoritative attribution: which named token performed the op.
-- Set from the VALIDATED JWT claim in wrap-read-jwt, never from client
-- input. NULL => the op was performed via a normal session login (human).
ALTER TABLE operations ADD COLUMN token_id TEXT NULL REFERENCES api_tokens(id);
--;;
CREATE INDEX idx_operations_token ON operations(token_id);
