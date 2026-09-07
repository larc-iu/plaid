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

  return (
    <CatalogContext.Provider value={{ vocabularies, loading, error, reload }}>
      {children}
    </CatalogContext.Provider>
  );
};
