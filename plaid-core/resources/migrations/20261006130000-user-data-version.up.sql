-- A version on each private data entry (2026-10-06), bumped by every write,
-- so a writer can say which version it read and be refused (409) when another
-- write landed since (`PUT /users/:id/data/:key?version=`). An assistant
-- conversation has two writers, the page and the service, and a write from
-- an older copy replaced the other's answer. Existing entries start at 1.
ALTER TABLE user_data ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
