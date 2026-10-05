import { useCallback, useRef, useState } from 'react';
import { humanizeError, statusOf } from '../lib/errors.js';
import { notifyError } from '../lib/notify.js';

// A read that came back unauthenticated, whichever way the client said so. An
// expired token is a fact about the session, not about the history, so it goes
// to the screen rather than into the rail. One writer for the rule, since the
// snapshot read in useHistoryView answers it the same way.
export const isExpiredSession = (err) =>
  err?.message === 'Not authenticated' || statusOf(err) === 401;

// How many of an entry's actions the rail reads at a time. One run of a
// machine service can be a single entry of forty thousand writes, and the
// list shows a count, not the writes: the rest of an entry is read when the
// reader opens it and asks for more.
export const OPS_SHOWN = 100;

// The rail's entries, every page of them, each with at most its oldest
// OPS_SHOWN actions and `opCount`, how many it has.
const readEntries = async (client, documentId) => {
  const entries = [];
  let cursor;
  do {
    const page = await client.documents.auditPage(documentId, {
      limit: 1000,
      opsLimit: OPS_SHOWN,
      cursor,
    });
    entries.push(...(page?.entries || []));
    cursor = page?.nextCursor;
  } while (cursor);
  return entries;
};

// A re-read keeps the actions a reader has already loaded of an entry: the
// list is read again after every edit while the rail is open.
const keepLoaded = (prev, next) => {
  const before = new Map(prev.map((e) => [e.id, e]));
  return next.map((e) => {
    const p = before.get(e.id);
    const held = p?.ops || [];
    const ops = e.ops || [];
    if (held.length <= ops.length || ops.some((op, i) => held[i]?.id !== op.id)) return e;
    return { ...e, ops: held };
  });
};

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
      const entries = await readEntries(client, documentId);
      if (mine !== readRef.current) return;
      loadedRef.current = true;
      setAuditEntries((prev) => keepLoaded(prev, entries));
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
      setError(humanizeError(err, 'Failed to read the history.'));
    } finally {
      if (mine === readRef.current) setLoadingAudit(false);
    }
  }, [documentId, client]);

  // The next OPS_SHOWN actions of an entry the read cut: the same entry read
  // again from its last action held, which comes back first and is dropped.
  // A failure says so in a toast and leaves the entry as it is.
  const [loadingMore, setLoadingMore] = useState(null);
  const latestEntries = useRef(auditEntries);
  latestEntries.current = auditEntries;
  const loadMoreOps = useCallback(
    async (entryId) => {
      const entry = latestEntries.current.find((e) => e.id === entryId);
      const last = entry?.ops?.[entry.ops.length - 1];
      if (!entry || !last || !client) return;
      setLoadingMore(entryId);
      try {
        const page = await client.documents.auditPage(documentId, {
          entryId,
          startTime: last.time,
          opsLimit: OPS_SHOWN + 1,
        });
        const more = page?.entries?.[0]?.ops || [];
        setAuditEntries((prev) =>
          prev.map((e) => {
            if (e.id !== entryId) return e;
            const held = new Set((e.ops || []).map((op) => op.id));
            return { ...e, ops: [...(e.ops || []), ...more.filter((op) => !held.has(op.id))] };
          }),
        );
      } catch (err) {
        if (isExpiredSession(err)) {
          onExpiredRef.current?.();
          return;
        }
        notifyError(err, 'Failed to load more actions');
      } finally {
        setLoadingMore(null);
      }
    },
    [documentId, client],
  );
  return {
    auditEntries,
    loadingAudit,
    hasLoadedAudit,
    error,
    fetchAuditLog,
    loadMoreOps,
    loadingMore,
  };
}
