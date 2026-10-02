DROP INDEX idx_audit_writes_target;
--;;
CREATE INDEX idx_audit_writes_target ON audit_writes (target_table, target_id, ts DESC, seq DESC)
  WHERE target_table = 'documents'
     OR target_table = 'text_layers'
     OR target_table = 'token_layers'
     OR target_table = 'span_layers'
     OR target_table = 'relation_layers'
     OR target_table = 'vocab_items'
     OR target_table = 'vocab_layers';
