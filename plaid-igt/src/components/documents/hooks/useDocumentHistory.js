import { useState, useCallback } from 'react';

// Owns the history-rail UI state + audit-log fetching. Time-travel itself is
// driven by the parent's `asOf` (which reloads the shared IgtDocument); this hook
// no longer fetches a separate historical document.
export const useDocumentHistory = (documentId, client) => {
  const [open, setOpen] = useState(false);
  const [selectedEntry, setSelectedEntry] = useState(null);
  const [auditEntries, setAuditEntries] = useState([]);
  const [loadingAudit, setLoadingAudit] = useState(false);
  const [error, setError] = useState('');
  const [hasLoadedAudit, setHasLoadedAudit] = useState(false);

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

  return {
    open,
    setOpen,
    selectedEntry,
    setSelectedEntry,
    auditEntries,
    loadingAudit,
    error,
    hasLoadedAudit,
    fetchAuditLog,
  };
};
