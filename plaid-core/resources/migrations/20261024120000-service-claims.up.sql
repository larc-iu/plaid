-- Who a service id on a project belongs to (2026-10-24, ruling R10): the
-- account that first opened a channel for it. Another account opening one is
-- refused, so a member cannot stand in for another member's service while it
-- is offline. Only an admin releases a claim
-- (`DELETE /projects/:id/services/:service-id/owner`), after which the next
-- account to open a channel claims it.
--
-- Its own table rather than a column of `seen_services`, so forgetting an
-- offline service there (a maintainer's registry hygiene) does not release
-- the id. Unaudited for the same reason as `seen_services`. Removed with its
-- project by the FK cascade.
CREATE TABLE service_claims (
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  service_id  TEXT NOT NULL,
  user_id     TEXT NOT NULL REFERENCES users(id),
  claimed_at  TEXT NOT NULL,
  PRIMARY KEY (project_id, service_id)
);
