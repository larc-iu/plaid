// Optimistic-patch helpers that mirror the server's merge reparenting
// (plaid-core token.clj `merge-tokens`: spans and vocab_links that referenced
// the merged-away token are reparented onto the surviving token, NOT deleted).
//
// The merge mutations replay the merge locally instead of reloading, so they
// must reproduce this reparenting — otherwise spans/links on the merged-away
// token are left referencing a now-removed id, rendering as nothing (the
// annotation/link appears deleted) until the next full reload heals it.
//
// Both helpers mutate in place and dedupe the resulting token list (a span
// could already reference the survivor).

export const reparentSpans = (spanLayers, removedIds, survivorId) => {
  (spanLayers || []).forEach(sl => {
    (sl.spans || []).forEach(s => {
      if (Array.isArray(s.tokens) && s.tokens.some(tid => removedIds.has(tid))) {
        s.tokens = [...new Set(s.tokens.map(tid => (removedIds.has(tid) ? survivorId : tid)))];
      }
    });
  });
};

export const reparentVocabLinks = (vocabularies, removedIds, survivorId) => {
  Object.values(vocabularies || {}).forEach(v => {
    (v.vocabLinks || []).forEach(link => {
      if (Array.isArray(link.tokens) && link.tokens.some(tid => removedIds.has(tid))) {
        link.tokens = [...new Set(link.tokens.map(tid => (removedIds.has(tid) ? survivorId : tid)))];
      }
    });
  });
};
