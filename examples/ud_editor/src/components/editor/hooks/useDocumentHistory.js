import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../../../contexts/AuthContext.jsx';

export const useDocumentHistory = (documentId) => {
  const [auditEntries, setAuditEntries] = useState([]);
  const [historicalDocument, setHistoricalDocument] = useState(null);
  const [loadingAudit, setLoadingAudit] = useState(false);
  const [loadingHistorical, setLoadingHistorical] = useState(false);
  const [error, setError] = useState('');
  const { getClient } = useAuth();

  // Fetch audit log entries
  const fetchAuditLog = useCallback(async () => {
    if (!documentId) return;
    
    try {
      setLoadingAudit(true);
      const client = getClient();
      if (!client) {
        window.location.href = '/login';
        return;
      }

      const auditData = await client.documents.audit(documentId);
      setAuditEntries(auditData || []);
      setError('');
    } catch (err) {
      if (err.status === 401) {
        window.location.href = '/login';
        return;
      }
      setError('Failed to load audit log: ' + (err.message || 'Unknown error'));
      console.error('Error fetching audit log:', err);
    } finally {
      setLoadingAudit(false);
    }
  }, [documentId, getClient]);

  // Fetch historical document state
  const fetchHistoricalDocument = useCallback(async (timestamp) => {
    if (!documentId || !timestamp) return null;
    
    try {
      setLoadingHistorical(true);
      setError('');
      const client = getClient();
      if (!client) {
        window.location.href = '/login';
        return null;
      }

      const historicalDoc = await client.documents.get(documentId, true, timestamp);
      setHistoricalDocument(historicalDoc);
      return historicalDoc;
    } catch (err) {
      if (err.status === 401) {
        window.location.href = '/login';
        return null;
      }
      setError('Failed to load historical document: ' + (err.message || 'Unknown error'));
      console.error('Error fetching historical document:', err);
      return null;
    } finally {
      setLoadingHistorical(false);
    }
  }, [documentId, getClient]);

  // Clear historical document (return to current state)
  const clearHistoricalDocument = useCallback(() => {
    setHistoricalDocument(null);
    setError('');
  }, []);

  useEffect(() => {
    if (documentId) {
      fetchAuditLog();
    }
  }, [fetchAuditLog]);

  return {
    auditEntries,
    historicalDocument,
    loadingAudit,
    loadingHistorical,
    error,
    fetchHistoricalDocument,
    clearHistoricalDocument,
    refreshAuditLog: fetchAuditLog
  };
};