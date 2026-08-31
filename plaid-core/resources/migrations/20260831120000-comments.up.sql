-- Comments (#comments).
--
-- Free-text discussion attached to one annotatable entity: a document, a
-- text, a token, a span, or a relation. Comments are SOCIAL data, not
-- annotation data. Writes are NOT audited, they do not bump the document
-- version, and they are never carried by an export target. Contrast
-- entity_metadata, which IS part of the linguistic record.
--
-- Flat by design: no threading and no resolve state. A comment is a row.
--
-- `project_id` and `document_id` are denormalized off the anchor entity at
-- insert time. That serves two ends: the two hot reads (every comment in a
-- document, every comment in a project) are single indexed scans, and FK
-- cascade reclaims comments when either ancestor goes away. Deleting the
-- anchor entity itself is swept by `plaid.sql.common/sweep-comments!` --
-- (entity_type, entity_id) is polymorphic, so no FK can reach it.
--
-- `author_id` has no ON DELETE clause, matching `invites.created_by`: it is
-- an attribution record, and users are not deletable in this system anyway.
CREATE TABLE comments (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  entity_id   TEXT NOT NULL,
  author_id   TEXT NOT NULL REFERENCES users(id),
  body        TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
--;;
-- The anchor read: every comment on one entity, oldest first. Also the index
-- the cascade sweep rides when an entity is deleted.
CREATE INDEX idx_comments_entity ON comments(entity_type, entity_id, created_at, id);
--;;
-- The document read: one request paints comment indicators over a whole doc.
CREATE INDEX idx_comments_document ON comments(document_id, created_at, id);
--;;
-- The project read: the "recent activity" list, and the paginated fallback.
CREATE INDEX idx_comments_project ON comments(project_id, created_at, id);
