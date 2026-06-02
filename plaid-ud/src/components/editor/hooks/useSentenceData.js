import { useMemo } from 'react';
import { ConlluDocument } from '../../../domain/ConlluDocument.js';

// Derives the sentence/word/morpheme rows used by the annotation grid and the
// CoNLL-U exporter. The hierarchy and form-resolution logic now lives on
// ConlluDocument; this hook stays for back-compat with existing consumers
// during the Phase 1 migration.
export const useSentenceData = (document) => {
  return useMemo(() => {
    if (!document) return [];
    const doc = new ConlluDocument({ raw: document });
    return doc.sentences;
  }, [document]);
};
