import { useState, useCallback, useRef } from 'react';
import { humanizeError, statusOf } from '@ui/lib/errors.js';

// A read that came back unauthenticated, whichever way the client said so. An
// expired token is a fact about the session, not about the history, so it goes
// to the screen rather than into the rail. One writer for the rule, since the
// snapshot read in useHistoryView answers it the same way.
export const isExpiredSession = (err) =>
  err?.message === 'Not authenticated' || statusOf(err) === 401;

// Owns the history-rail UI state + audit-log fetching. Time-travel itself is
// driven by the parent's `asOf` (which reloads the shared IgtDocument); this hook
// no longer fetches a separate historical document.
//
// `onExpired` is called when the audit read comes back unauthenticated. It is
// read through a ref: every screen passes it inline, and the fetcher must not
// get a new identity on every render because of it.
export const useDocumentHistory = (documentId, client, onExpired) => {
  const [open, setOpen] = useState(false);
  const [selectedEntry, setSelectedEntry] = useState(null);
  const [auditEntries, setAuditEntries] = useState([]);
  const [loadingAudit, setLoadingAudit] = useState(false);
  const [error, setError] = useState('');
  const [hasLoadedAudit, setHasLoadedAudit] = useState(false);
  const onExpiredRef = useRef(onExpired);
  onExpiredRef.current = onExpired;

  const fetchAuditLog = useCallback(async () => {
    if (!documentId || !client) return;
    try {
      setLoadingAudit(true);
      const auditData = await client.documents.audit(documentId);
      setAuditEntries(auditData || []);
      setHasLoadedAudit(true);
      setError('');
    } catch (err) {
      console.error('Error fetching audit log:', err);
      if (isExpiredSession(err)) {
        onExpiredRef.current?.();
        return;
      }
      // The rail renders this verbatim, and a raw client message carries the
      // request URL and the ids it was given.
      setError(humanizeError(err, 'The history could not be loaded.'));
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
