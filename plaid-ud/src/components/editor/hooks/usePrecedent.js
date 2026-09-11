import { useCallback, useEffect, useRef } from 'react';
import { precedentQueries, mergeCounts } from '../../../domain/precedent.js';

// One lookup of "what has this project said before", cached for as long as the
// document is open.
//
// The cache is per document load, keyed by field and key: a corpus's answer for
// `dog` does not change while you are typing, and Alt+Down on the same cell
// twice should not ask twice. It is dropped when the document changes, which is
// also when the answers might.
export function usePrecedent({ client, projectId, layerInfo, documentId }) {
  const cache = useRef(new Map());

  useEffect(() => {
    cache.current = new Map();
  }, [documentId]);

  const morpheme = layerInfo?.morphemeTokenLayer?.id;
  const form = layerInfo?.formLayer?.id;
  const lemma = layerInfo?.lemmaLayer?.id;
  const xpos = layerInfo?.xposLayer?.id;
  const features = layerInfo?.featuresLayer?.id;

  return useCallback(
    async (field, key) => {
      const layers = { morpheme, form, lemma, xpos, features };
      const queries = precedentQueries(projectId, layers, field, key);
      if (!queries || !client) return [];
      const id = `${field} ${key}`;
      if (cache.current.has(id)) return cache.current.get(id);
      // Cache the PROMISE, not the result: two cells asking at once should make
      // one request, and the second should wait for the first rather than
      // starting another.
      const pending = Promise.all(queries.map((q) => client.query(q)))
        .then((responses) => mergeCounts(responses.map((r) => r?.results || [])))
        .catch((err) => {
          console.error('Could not read precedent:', err);
          cache.current.delete(id);
          return [];
        });
      cache.current.set(id, pending);
      return pending;
    },
    [client, projectId, morpheme, form, lemma, xpos, features],
  );
}
