-- The scoped (delegated) token whose write created a logical-operation group
-- (2026-09-29). A delegated token names projects, a group names none, so the
-- scope gate refused every relabel by one. The token's `jti` is kept here so
-- that token, and no other, may relabel the groups its own writes created
-- (`plaid.rest-api.v1.auth/operation-group-token-scope`). NULL when a session
-- or a named API token created the group.
ALTER TABLE operation_groups ADD COLUMN scoped_token TEXT NULL;
