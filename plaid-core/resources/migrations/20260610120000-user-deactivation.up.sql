-- Users are never hard-deleted: operations.user_id / operations.token_id
-- FKs (NO ACTION) deliberately block it, because audit attribution must
-- survive forever. DELETE /users/:id is now an audited DEACTIVATION that
-- sets this column (NULL = active); login and JWT validation reject
-- deactivated users, and POST /users/:id/activate clears it.
ALTER TABLE users ADD COLUMN deactivated_at TEXT NULL;
