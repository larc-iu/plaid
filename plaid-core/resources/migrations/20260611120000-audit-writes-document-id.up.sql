-- Denormalized document attribution for audit rows, the foundation for
-- serving ?as-of= reads directly from the audit log (XTDB-removal plan,
-- Phase 1). Joining via operations.document_id is INCOMPLETE: cascade
-- rows under NULL-document ops (project/delete, vocab/delete,
-- project/remove-vocab) lose their document — and it can even be WRONG
-- (a pre-guard cross-document bulk-delete left a row whose op says doc A
-- but whose image says doc B). The row's own image is the authority:
-- every document-scoped entity's image carries document_id, and for the
-- documents table the target IS the document.
ALTER TABLE audit_writes ADD COLUMN document_id TEXT NULL;
--;;
UPDATE audit_writes SET document_id = COALESCE(
  json_extract(post_image, '$.document_id'),
  json_extract(pre_image, '$.document_id'),
  CASE WHEN target_table = 'documents' THEN target_id END);
--;;
-- Covering index for as-of reconstruction: all audit rows for one
-- document, ordered. (ts, seq) totally orders the log — operations.ts is
-- strictly monotonic and audit rows inherit their op's ts.
CREATE INDEX idx_audit_writes_document_ts ON audit_writes (document_id, ts, seq);
