import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../../../contexts/AuthContext.jsx';

export const useDocumentData = (projectId, documentId) => {
  const [document, setDocument] = useState(null);
  const [project, setProject] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const { getClient } = useAuth();

  const fetchData = useCallback(async () => {
    if (!projectId || !documentId) return;
    
    try {
      setLoading(true);
      const client = getClient();
      if (!client) {
        window.location.href = '/login';
        return;
      }

      const [projectData, documentData] = await Promise.all([
        client.projects.get(projectId),
        client.documents.get(documentId, true)
      ]);
      
      setProject(projectData);
      setDocument(documentData);
      client.enterStrictMode(documentId)
      setError('');
    } catch (err) {
      if (err.status === 401) {
        window.location.href = '/login';
        return;
      }
      setError('Failed to load document: ' + (err.message || 'Unknown error'));
      console.error('Error fetching data:', err);
    } finally {
      setLoading(false);
    }
  }, [projectId, documentId, getClient]);

  const refreshData = useCallback(async () => {
    await fetchData();
  }, [fetchData]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  return {
    document,
    project,
    loading,
    error,
    setDocument,
    setError,
    refreshData
  };
};