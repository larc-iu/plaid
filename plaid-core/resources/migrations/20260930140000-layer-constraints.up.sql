-- Layer constraints (2026-09-30). An app declares rules on the token, span
-- and relation layers it owns, and core enforces them inside every write
-- transaction (plaid.sql.constraints.layer). The column holds a JSON object
-- from the declaring app's namespace to its list of constraint objects, so
-- two apps sharing a layer never overwrite each other's rules. '{}' means
-- nothing is declared and nothing is enforced.
ALTER TABLE token_layers ADD COLUMN constraints TEXT NOT NULL DEFAULT '{}';
--;;
ALTER TABLE span_layers ADD COLUMN constraints TEXT NOT NULL DEFAULT '{}';
--;;
ALTER TABLE relation_layers ADD COLUMN constraints TEXT NOT NULL DEFAULT '{}';
