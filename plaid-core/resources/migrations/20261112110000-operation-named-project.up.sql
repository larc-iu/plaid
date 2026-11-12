-- An operation whose description names a project other than the reader's own
-- (2026-11-12): moving a vocabulary to project "Q", a vocabulary belonging to
-- project "P", linking or unlinking a vocabulary of another project. Such an
-- operation is listed to people who may not read that project (a vocabulary's
-- History is read by every project that borrows it, a project's Activity by
-- its own readers), and must not give them its name. `named_project_id` is the
-- project the description names, `anonymous_description` the same sentence
-- with "another project" in its place, which an audit read gives a reader who
-- cannot read that project. Both NULL for every other operation, and for one
-- whose description a client supplied (`?audit-message=`).
ALTER TABLE operations ADD COLUMN named_project_id TEXT NULL;
--;;
ALTER TABLE operations ADD COLUMN anonymous_description TEXT NULL;
