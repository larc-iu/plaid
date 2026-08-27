-- One-time, link-shaped credential grants: signup invites and admin-issued
-- password resets. Motivation: this deployment deliberately has no email
-- integration, so onboarding a user previously meant an admin inventing a
-- temporary password and sending it over some side channel, then trusting
-- the recipient to change it. An invite replaces that with a link the
-- recipient redeems by choosing their OWN credentials, which the server
-- never has to transmit.
--
-- Two kinds, distinguished by `target_user_id` rather than a stored `kind`
-- column (a stored kind would be derivable state that can disagree with the
-- FK):
--   target_user_id IS NULL     -> signup. Redeemer picks a username and
--                                 password; the grant columns decide what
--                                 the new account gets.
--   target_user_id IS NOT NULL -> password reset for that user. Redeemer
--                                 sets a new password only.
--
-- The plaintext code is NEVER stored. `code_hash` is a plain SHA-256 hex
-- digest, not bcrypt: the code is 160 bits of CSPRNG output, so there is no
-- dictionary to attack and a slow KDF would buy nothing while forcing a
-- full table scan on every redemption (bcrypt salts differ per row, so it
-- cannot be looked up by equality). A fast digest keeps redemption a single
-- indexed point lookup.
--
-- Rows are kept forever and revoked SOFTLY, exactly like `api_tokens`:
-- `operations` rows reference the invite through the audit log, and a
-- maintainer needs to be able to see that an invite was used and by whom.
CREATE TABLE invites (
  id             TEXT PRIMARY KEY,                 -- UUIDv7
  code_hash      TEXT NOT NULL UNIQUE,             -- SHA-256 hex of the plaintext code
  created_by     TEXT NOT NULL REFERENCES users(id),
  created_at     TEXT NOT NULL,
  expires_at     TEXT NOT NULL,                    -- ISO instant; always set (no immortal invites)
  max_uses       INTEGER NOT NULL DEFAULT 1 CHECK (max_uses >= 1),
  uses           INTEGER NOT NULL DEFAULT 0 CHECK (uses >= 0),
  revoked_at     TEXT NULL,                        -- soft-revoke; non-null => dead
  note           TEXT NULL,                        -- human label, e.g. "Fall 2026 field methods"

  -- Grants applied at redemption. All NULL/0 for a password reset.
  target_user_id TEXT NULL REFERENCES users(id),   -- non-null => password reset
  grant_admin    INTEGER NOT NULL DEFAULT 0 CHECK (grant_admin IN (0, 1)),
  project_id     TEXT NULL REFERENCES projects(id) ON DELETE CASCADE,
  project_role   TEXT NULL CHECK (project_role IN ('reader', 'writer', 'maintainer')),

  -- A project grant is a pair: both columns or neither.
  CHECK ((project_id IS NULL) = (project_role IS NULL)),
  -- A password reset targets exactly one user once, and grants nothing:
  -- re-granting roles on a reset would let a reset link silently change a
  -- user's authority.
  CHECK (target_user_id IS NULL
         OR (max_uses = 1 AND grant_admin = 0 AND project_id IS NULL))
);
--;;
-- Redemption looks a code up by digest; this is the hot path and the only
-- way rows are found by an unauthenticated caller.
CREATE UNIQUE INDEX idx_invites_code_hash ON invites(code_hash);
--;;
-- "Invites I minted", oldest-first, is the admin/maintainer listing.
-- (created_at, id) is the keyset pagination order.
CREATE INDEX idx_invites_creator ON invites(created_by, created_at, id);
--;;
-- "Invites for this project" powers the per-project invite panel.
CREATE INDEX idx_invites_project ON invites(project_id, created_at, id);
