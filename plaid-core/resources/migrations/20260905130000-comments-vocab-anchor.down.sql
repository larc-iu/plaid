-- Back to project-owned comments only. Comments on vocabulary entries have
-- no representation in the old shape and are dropped; captions are dropped.
CREATE TABLE comments_old (
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
INSERT INTO comments_old (id, project_id, document_id, entity_type, entity_id, author_id, body,
                          created_at, updated_at)
  SELECT id, project_id, document_id, entity_type, entity_id, author_id, body, created_at, updated_at
    FROM comments
   WHERE project_id IS NOT NULL;
--;;
DROP TABLE comments;
--;;
ALTER TABLE comments_old RENAME TO comments;
--;;
CREATE INDEX idx_comments_entity ON comments(entity_type, entity_id, created_at, id);
--;;
CREATE INDEX idx_comments_document ON comments(document_id, created_at, id);
--;;
CREATE INDEX idx_comments_project ON comments(project_id, created_at, id);
