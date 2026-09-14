import { useState, useCallback, useRef } from 'react';
import { useAuth } from '../../../contexts/AuthContext.jsx';
import { notifyError, humanizeError } from '../../../utils/feedback.jsx';

export const useDocumentHistory = (documentId) => {
  const [auditEntries, setAuditEntries] = useState([]);
  const [historicalDocument, setHistoricalDocument] = useState(null);
  const [loadingAudit, setLoadingAudit] = useState(false);
  const [loadingHistorical, setLoadingHistorical] = useState(false);
  const [hasLoadedAudit, setHasLoadedAudit] = useState(false);
  // Why the entry list is empty. Only the audit fetch sets it: a failed time
  // travel leaves the entries a reader is browsing on screen and says so in a
  // toast, and the drawer hides the list whenever this is set.
  const [error, setError] = useState('');
  // Which as-of read the document on screen belongs to. Two reads can be out at
  // once (a reader clicking down a list of entries), they can land in either
  // order, and the state one of them is answering is only ever the last one
  // asked for. The caller has its own guard for the SELECTION, which this one
  // knows nothing about: this is about the document itself.
  const latestRead = useRef(0);
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
      setError('');
    } catch (err) {
      if (err.status === 401) {
        logout();
        return;
      }
      setError(humanizeError(err, 'The history could not be read.'));
      notifyError(humanizeError(err), 'Failed to load the history');
      console.error('Error fetching audit log:', err);
    } finally {
      setLoadingAudit(false);
    }
  }, [documentId, getClient, logout]);

  // Fetch historical document state
  const fetchHistoricalDocument = useCallback(
    async (timestamp) => {
      if (!documentId || !timestamp) return null;

      const mine = ++latestRead.current;
      try {
        setLoadingHistorical(true);
        const client = getClient();
        if (!client) {
          logout();
          return null;
        }

        const historicalDoc = await client.documents.get(documentId, true, timestamp);
        if (mine === latestRead.current) setHistoricalDocument(historicalDoc);
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
        const msg = `Couldn't load the document at that point in time${status}: ${humanizeError(err)}`;
        notifyError(msg, 'Time travel failed');
        console.error('Error fetching historical document:', err);
        return null;
      } finally {
        setLoadingHistorical(false);
      }
    },
    [documentId, getClient, logout],
  );

  // Clear historical document (return to current state). A read still out
  // belongs to the screen the reader has just left, so it is disowned here too
  // rather than landing on the live document a moment later.
  const clearHistoricalDocument = useCallback(() => {
    latestRead.current++;
    setHistoricalDocument(null);
  }, []);

  return {
    auditEntries,
    historicalDocument,
    loadingAudit,
    loadingHistorical,
    hasLoadedAudit,
    error,
    fetchHistoricalDocument,
    clearHistoricalDocument,
    fetchAuditLog,
  };
};
