-- Remove the X-Agent-Name / user_agent mechanism. Named API tokens
-- (operations.token_id → api_tokens.name, surfaced as :audit/api-token) now
-- provide authoritative, non-spoofable machine attribution, superseding the
-- free-text, client-controlled user_agent label. See the api-tokens migration
-- 20260601120000. The column carried only a display string (never entity
-- state, never mirrored to history), so dropping it is safe for the audit/CDC log.
ALTER TABLE operations DROP COLUMN user_agent;
