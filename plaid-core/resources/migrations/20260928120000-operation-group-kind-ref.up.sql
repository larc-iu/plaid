-- What kind of operation a logical-operation group is, and what it refers to
-- (2026-09-28), for a study that reads the audit log as its record.
--
-- `message` is free text for a person to read. `kind` is one word from a
-- small vocabulary the server checks (`plaid.sql.operation-group/kinds`:
-- assistant-plan, service-run, import, bulk-edit, guess-adoption, repair), so
-- a reader can count operations by kind without parsing labels. `ref` is a
-- short client string naming what the operation came from, in a shape each
-- kind documents (an assistant plan's `conv:<id>/plan:<id>/service:<id>`).
-- Both come from `?group-kind=` / `?group-ref=` on the group's first write,
-- like the message, and nothing changes them afterwards.
ALTER TABLE operation_groups ADD COLUMN kind TEXT NULL;
--;;
ALTER TABLE operation_groups ADD COLUMN ref TEXT NULL;
