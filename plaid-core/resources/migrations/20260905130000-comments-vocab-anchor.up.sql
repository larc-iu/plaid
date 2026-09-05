-- Comments on vocabulary entries, and a caption for outdated comments (#comments).
--
-- Two changes to `comments`, both about what a comment can hang off:
--
--   * A comment may now anchor to a VOCAB ITEM. A vocabulary belongs to no
--     project (it is shared across them), so such a comment is owned by its
--     vocab layer instead: `vocab_layer_id` is set and `project_id` /
--     `document_id` are NULL. The CHECK pins exactly one owner, so the two
--     hot reads (a document's comments, a vocabulary's comments) stay single
--     indexed scans and FK cascade still reclaims rows when the owner goes.
--
--   * `anchor_label` is what the comment was about, in words, captured when
--     it was posted ("Gloss of ktab, sentence 4"; an entry's form). A comment
--     now OUTLIVES its anchor: deleting a token, span, or entry no longer
--     sweeps the comments on it. The app shows such a comment as outdated,
--     the way a code review keeps a comment on a line that has since
--     changed, and the caption is what it has left to show. Nothing else
--     reads the column. Client-supplied and display-only.
--
-- SQLite cannot relax NOT NULL in place, hence the rebuild. `comments` has no
-- incoming foreign keys, so dropping and renaming is safe with foreign_keys
-- on. Every existing row is project-owned and keeps its columns verbatim.
CREATE TABLE comments_new (
  id             TEXT PRIMARY KEY,
  project_id     TEXT REFERENCES projects(id) ON DELETE CASCADE,
  document_id    TEXT REFERENCES documents(id) ON DELETE CASCADE,
  vocab_layer_id TEXT REFERENCES vocab_layers(id) ON DELETE CASCADE,
  entity_type    TEXT NOT NULL,
  entity_id      TEXT NOT NULL,
  author_id      TEXT NOT NULL REFERENCES users(id),
  body           TEXT NOT NULL,
  anchor_label   TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  CHECK ((project_id IS NOT NULL AND document_id IS NOT NULL AND vocab_layer_id IS NULL)
      OR (project_id IS NULL AND document_id IS NULL AND vocab_layer_id IS NOT NULL))
);
--;;
INSERT INTO comments_new (id, project_id, document_id, entity_type, entity_id, author_id, body,
                          created_at, updated_at)
  SELECT id, project_id, document_id, entity_type, entity_id, author_id, body, created_at, updated_at
    FROM comments;
--;;
DROP TABLE comments;
--;;
ALTER TABLE comments_new RENAME TO comments;
--;;
-- The anchor read: every comment on one entity, oldest first.
CREATE INDEX idx_comments_entity ON comments(entity_type, entity_id, created_at, id);
--;;
-- The document read: one request paints comment indicators over a whole doc.
CREATE INDEX idx_comments_document ON comments(document_id, created_at, id);
--;;
-- The project read: the "recent activity" list, and the paginated fallback.
CREATE INDEX idx_comments_project ON comments(project_id, created_at, id);
--;;
-- The vocabulary read: every comment on a vocabulary's entries, and its counts.
CREATE INDEX idx_comments_vocab_layer ON comments(vocab_layer_id, created_at, id);
