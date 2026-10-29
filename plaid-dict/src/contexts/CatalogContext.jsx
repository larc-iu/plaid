import { createContext, useContext, useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { vocabImporting, withLiveMarks } from '@igt/domain/igtConfig.js';

// Every vocabulary this user can read, loaded once. A dictionary is reached by
// its slug, which lives in the vocabulary's own config, so the list is what
// resolves a URL as well as what fills the landing screen.
const CatalogContext = createContext(null);

export const useCatalog = () => {
  const context = useContext(CatalogContext);
  if (!context) throw new Error('useCatalog must be used within a CatalogProvider');
  return context;
};

export const CatalogProvider = ({ children }) => {
  const { client, logout } = useAuth();
  // Every vocabulary the user can read, and the ones that are dictionaries:
  // all but one an unfinished import made, which is no dictionary until that
  // import is over (igt's R58), so it is neither listed nor reached by its
  // address. It still holds its address, which Setup counts as taken.
  const [allVocabularies, setAllVocabularies] = useState([]);
  const vocabularies = useMemo(
    () => allVocabularies.filter((v) => !vocabImporting(v.config)),
    [allVocabularies],
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // vocabLayerId -> entry count. Null until the query answers, and left null
  // when it cannot run: a vocabulary-only maintainer has no project access, so
  // the count query 400s for them. Counts are a nicety, never a blocker.
  const [itemCounts, setItemCounts] = useState(null);

  const reload = useCallback(async () => {
    if (!client) return;
    setLoading(true);
    try {
      setAllVocabularies(await withLiveMarks(client, await client.vocabLayers.list()));
      setError('');
    } catch (err) {
      if (err.status === 401) {
        logout('expired');
        return;
      }
      console.error('Failed to load vocabularies:', err);
      setError('Failed to load the dictionaries.');
    } finally {
      setLoading(false);
    }
  }, [client, logout]);

  useEffect(() => {
    reload();
  }, [reload]);

  // One grouped aggregate over every vocabulary the user can read. Several
  // vocabularies share a name on a working server, so the count is often the
  // only thing that tells two rows apart.
  useEffect(() => {
    if (!client || !vocabularies.length) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const [res, projects] = await Promise.all([
          client.query({
            where: [['vocab', '?v', { layer: '?l' }]],
            return: { group: ['?l'], aggregates: [['count']] },
          }),
          client.projects.list(),
        ]);
        // The query reaches a vocabulary through the projects that link it,
        // and gives no row for one with no entries. So a vocabulary a listed
        // project links counts 0 until the query says otherwise, and one no
        // listed project links is not counted at all.
        const byLayer = {};
        for (const project of projects) {
          for (const v of project.vocabs || []) byLayer[v.id] = 0;
        }
        for (const [layerId, n] of res?.results || []) byLayer[layerId] = n;
        if (!cancelled) setItemCounts(byLayer);
      } catch (err) {
        console.error('Entry-count query failed:', err);
        if (!cancelled) setItemCounts(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, vocabularies]);

  return (
    <CatalogContext.Provider
      value={{ vocabularies, allVocabularies, itemCounts, loading, error, reload }}
    >
      {children}
    </CatalogContext.Provider>
  );
};
