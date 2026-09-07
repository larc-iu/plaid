import { createContext, useContext, useCallback, useEffect, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';

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
  const [vocabularies, setVocabularies] = useState([]);
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
      setVocabularies(await client.vocabLayers.list());
      setError('');
    } catch (err) {
      if (err.status === 401) {
        logout('expired');
        return;
      }
      console.error('Failed to load vocabularies:', err);
      setError('The dictionaries could not be loaded.');
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
        const res = await client.query({
          where: [['vocab', '?v', { layer: '?l' }]],
          return: { group: ['?l'], aggregates: [['count']] },
        });
        const byLayer = {};
        for (const [layerId, n] of res?.results || []) byLayer[layerId] = n;
        if (!cancelled) {
          setItemCounts(Object.fromEntries(vocabularies.map((v) => [v.id, byLayer[v.id] ?? 0])));
        }
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
    <CatalogContext.Provider value={{ vocabularies, itemCounts, loading, error, reload }}>
      {children}
    </CatalogContext.Provider>
  );
};
