import { useState, useCallback } from 'react';
import { useAuth } from '../../../contexts/AuthContext.jsx';
import { notifyError } from '../../../utils/feedback.jsx';

export const useDocumentHistory = (documentId) => {
  const [auditEntries, setAuditEntries] = useState([]);
  const [historicalDocument, setHistoricalDocument] = useState(null);
  const [loadingAudit, setLoadingAudit] = useState(false);
  const [loadingHistorical, setLoadingHistorical] = useState(false);
  const [hasLoadedAudit, setHasLoadedAudit] = useState(false);
  const { getClient, logout } = useAuth();

  // Fetch audit log entries
  const fetchAuditLog = useCallback(async () => {
    if (!documentId) return;
    
    try {
      setLoadingAudit(true);
      const client = getClient();
      if (!client) {
        logout();
        return;
      }

      const auditData = await client.documents.audit(documentId);
      setAuditEntries(auditData || []);
      setHasLoadedAudit(true);
    } catch (err) {
      if (err.status === 401) {
        logout();
        return;
      }
      notifyError('Failed to load audit log: ' + (err.message || 'Unknown error'));
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
      const client = getClient();
      if (!client) {
        logout();
        return null;
      }

      const historicalDoc = await client.documents.get(documentId, true, timestamp);
      setHistoricalDocument(historicalDoc);
      return historicalDoc;
    } catch (err) {
      if (err.status === 401) {
        logout();
        return null;
      }
      // Time travel to a past state failed (non-200). Fail loudly via a toast
      // so it's obvious even when the drawer is closed — but DON'T disturb the
      // drawer's entry list (a transient failure shouldn't wipe the history you
      // were browsing). Surface the HTTP status. (As-of reads come straight
      // from the audit log — no replica, so no 425/"not caught up" class.)
      const status = err.status ? ` (HTTP ${err.status})` : '';
      const msg = `Couldn't load the document at that point in time${status}: ${err.message || 'Unknown error'}`;
      notifyError(msg, 'Time travel failed');
      console.error('Error fetching historical document:', err);
      return null;
    } finally {
      setLoadingHistorical(false);
    }
  }, [documentId, getClient]);

  // Clear historical document (return to current state)
  const clearHistoricalDocument = useCallback(() => {
    setHistoricalDocument(null);
  }, []);

  return {
    auditEntries,
    historicalDocument,
    loadingAudit,
    loadingHistorical,
    hasLoadedAudit,
    fetchHistoricalDocument,
    clearHistoricalDocument,
    fetchAuditLog
  };
};