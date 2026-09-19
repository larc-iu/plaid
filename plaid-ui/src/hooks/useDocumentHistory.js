import { useCallback, useRef, useState } from 'react';
import { humanizeError, statusOf } from '../lib/errors.js';

// A read that came back unauthenticated, whichever way the client said so. An
// expired token is a fact about the session, not about the history, so it goes
// to the screen rather than into the rail. One writer for the rule, since the
// snapshot read in useHistoryView answers it the same way.
export const isExpiredSession = (err) =>
  err?.message === 'Not authenticated' || statusOf(err) === 401;

// The entry list of a document's history rail: read each time the rail opens
// and whenever the document changes under an open rail, so an edit made since
// is there to view and restore. Time travel itself is useHistoryView's.
//
// `onExpired` is read through a ref: every screen passes it inline, and the
// fetcher must not get a new identity on every render because of it.
export function useDocumentHistory({ documentId, client, onExpired }) {
  const [auditEntries, setAuditEntries] = useState([]);
  const [loadingAudit, setLoadingAudit] = useState(false);
  const [hasLoadedAudit, setHasLoadedAudit] = useState(false);
  // Why the entry list is empty. The rail hides the list whenever this is set,
  // and only the list's own read sets it: a failed time travel leaves the
  // entries a reader is browsing on screen and says so in a toast.
  const [error, setError] = useState('');
  const onExpiredRef = useRef(onExpired);
  onExpiredRef.current = onExpired;
  // Only the first read shows as loading: a list already on screen stays
  // while it is read again, instead of flashing to a spinner on every edit.
  // And the latest read wins, whichever order the answers come in.
  const loadedRef = useRef(false);
  const readRef = useRef(0);

  const fetchAuditLog = useCallback(async () => {
    if (!documentId || !client) return;
    const mine = ++readRef.current;
    try {
      if (!loadedRef.current) setLoadingAudit(true);
      const entries = await client.documents.audit(documentId);
      if (mine !== readRef.current) return;
      loadedRef.current = true;
      setAuditEntries(entries || []);
      setHasLoadedAudit(true);
      setError('');
    } catch (err) {
      if (mine !== readRef.current) return;
      if (isExpiredSession(err)) {
        onExpiredRef.current?.();
        return;
      }
      console.error('Error fetching audit log:', err);
      // The rail renders this verbatim, and a raw client message carries the
      // request URL and the ids it was given.
      setError(humanizeError(err, 'The history could not be read.'));
    } finally {
      if (mine === readRef.current) setLoadingAudit(false);
    }
  }, [documentId, client]);

  return { auditEntries, loadingAudit, hasLoadedAudit, error, fetchAuditLog };
}
