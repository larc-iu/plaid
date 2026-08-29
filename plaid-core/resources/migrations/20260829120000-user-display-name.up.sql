-- Display names (#user-display-name).
--
-- Splits what `users.username` was pretending to be into the two things it
-- actually needed to be:
--
--   * the login identity, which is `users.id` and always was — `POST /login`
--     looks the account up by primary key, so the only address that ever got
--     anyone in was the id. It is immutable by construction and no endpoint
--     offers to change it.
--
--   * `display_name`, a free-form label the user picks, which is how a person
--     is shown everywhere in the apps. NOT NULL so no reader ever has to spell
--     a fallback, seeded from the local part of the address ("alice@x.edu" ->
--     "alice"), and deliberately NOT unique: two people may share a name.
--
-- `username` itself stays behind, unexposed and equal to the id, purely
-- because SQLite cannot drop a UNIQUE-indexed column without rebuilding the
-- whole table — and every FK in the schema points at `users`. Its redundant
-- uniqueness costs nothing next to the PK that already enforces it. Nothing
-- reads it: `plaid.sql.user/row->user` no longer projects it.
--
-- Seeded from `username` rather than `id` so that an account which renamed
-- itself back when that was possible keeps the name it chose last.
ALTER TABLE users ADD COLUMN display_name TEXT NOT NULL DEFAULT '';
--;;
UPDATE users
   SET display_name = CASE WHEN instr(username, '@') > 1
                           THEN substr(username, 1, instr(username, '@') - 1)
                           ELSE username
                      END;
--;;
-- Backs the roster's ORDER BY (display_name, id): display names are not
-- unique, so the id rides along as the keyset tiebreaker.
CREATE INDEX idx_users_display_name_id ON users(display_name, id);
