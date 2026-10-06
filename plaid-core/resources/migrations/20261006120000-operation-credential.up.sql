-- Which kind of credential made each operation (2026-10-06), for a study that
-- reads the audit log as its record. `token_id` already names the named API
-- token behind a write. `credential` says what signed the request:
-- `login` (a session from signing in with a password), `named-token`,
-- `service` (a named token holding a service connection when it wrote) or
-- `delegated` (the short-lived token a service is handed for its requester).
-- Set by the server from the validated token, never by a client. NULL on
-- operations from before this column and on the server's own writes.
ALTER TABLE operations ADD COLUMN credential TEXT NULL;
