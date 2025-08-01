import { useState, useCallback } from 'react';

export const useDocumentHistory = (documentId, client) => {
  const [auditEntries, setAuditEntries] = useState([]);
  const [historicalDocument, setHistoricalDocument] = useState(null);
  const [loadingAudit, setLoadingAudit] = useState(false);
  const [loadingHistorical, setLoadingHistorical] = useState(false);
  const [error, setError] = useState('');
  const [hasLoadedAudit, setHasLoadedAudit] = useState(false);

  // Fetch audit log entries
  const fetchAuditLog = useCallback(async () => {
    if (!documentId || !client) return;
    
    try {
      setLoadingAudit(true);
      const auditData = await client.documents.audit(documentId);
      setAuditEntries(auditData || []);
      setHasLoadedAudit(true);
      setError('');
    } catch (err) {
      setError('Failed to load audit log: ' + (err.message || 'Unknown error'));
      console.error('Error fetching audit log:', err);
    } finally {
      setLoadingAudit(false);
    }
  }, [documentId, client]);

  // Fetch historical document state
  const fetchHistoricalDocument = useCallback(async (timestamp) => {
    if (!documentId || !timestamp || !client) return null;
    
    try {
      setLoadingHistorical(true);
      setError('');
      const historicalDoc = await client.documents.get(documentId, true, timestamp);
      setHistoricalDocument(historicalDoc);
      return historicalDoc;
    } catch (err) {
      setError('Failed to load historical document: ' + (err.message || 'Unknown error'));
      console.error('Error fetching historical document:', err);
      return null;
    } finally {
      setLoadingHistorical(false);
    }
  }, [documentId, client]);

  // Clear historical document (return to current state)
  const clearHistoricalDocument = useCallback(() => {
    setHistoricalDocument(null);
    setError('');
  }, []);

  return {
    auditEntries,
    historicalDocument,
    loadingAudit,
    loadingHistorical,
    error,
    hasLoadedAudit,
    fetchHistoricalDocument,
    clearHistoricalDocument,
    fetchAuditLog
  };
};