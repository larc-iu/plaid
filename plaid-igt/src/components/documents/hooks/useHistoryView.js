import { useEffect, useState } from 'react';
import { notifyError, humanizeError } from '@/utils/feedback';
import { isExpiredSession, useDocumentHistory } from './useDocumentHistory.js';

// Time travel: the history rail, the snapshot being viewed, and the restore it
// can lead to. One concern with three pieces of state that only make sense
// together, which is why it is a hook rather than three `useState`s in the
// middle of the editor.
//
// `asOf` is the whole of the mechanism. Selecting an entry sets it, and the
// effect below swaps the shared IgtDocument for that snapshot by re-reading
// ONLY the document, reusing the project / vocab / item levels already loaded
// (IgtDocument#atAsOf). It deliberately does NOT blank `doc`: the old full
// reload unmounted the whole editor to a spinner for ~1.4s on every history
// click, which read as a full page refresh.
//
// `onExpired` is called when a read comes back unauthenticated, the snapshot's
// here and the entry list's in useDocumentHistory.
export function useHistoryView({ documentId, client, doc, setDoc, onExpired }) {
  const [asOf, setAsOf] = useState(null);
  // The history entry a restore is being confirmed for (RestoreDialog).
  const [restoreEntry, setRestoreEntry] = useState(null);
  const history = useDocumentHistory(documentId, client, onExpired);

  useEffect(() => {
    if (!doc) return undefined;
    // Also the exit path: selecting nothing sets asOf back to null.
    if ((doc.asOf ?? null) === (asOf ?? null)) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const next = await doc.atAsOf(asOf);
        if (cancelled) return;
        next.onError = doc.onError;
        setDoc(next);
      } catch (e) {
        if (cancelled) return;
        if (isExpiredSession(e)) {
          onExpired();
          return;
        }
        console.error('Failed to load snapshot:', e);
        // Keep showing what is on screen rather than blanking the editor, and
        // put the rail back where the view actually is.
        notifyError(humanizeError(e, 'That snapshot could not be loaded.'));
        setAsOf(doc.asOf ?? null);
        history.setSelectedEntry(null);
      }
    })();
    return () => {
      cancelled = true;
    };
    // Keyed on the document and the snapshot only; the rest is read fresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, asOf]);

  const openHistory = () => {
    history.setOpen(true);
    if (!history.hasLoadedAudit) history.fetchAuditLog();
  };

  const selectEntry = (entry) => {
    history.setSelectedEntry(entry);
    setAsOf(entry ? entry.time : null);
  };

  const closeHistory = () => {
    history.setOpen(false);
    if (history.selectedEntry) selectEntry(null);
  };

  // After a restore (or an undo of one) the live document has changed and the
  // rail has a new newest entry. From a snapshot the effect above re-reads the
  // document; from live (the toast's Undo) it is re-read IN PLACE, since
  // setting asOf to null again changes nothing. In place because a new
  // IgtDocument rebuilds the island and throws away the reader's position in a
  // document they have just changed and want to check. Called from the toast
  // too, long after the dialog has closed.
  const handleRestored = async () => {
    if (asOf != null) selectEntry(null);
    else if (doc) await doc.reload();
    await history.fetchAuditLog();
  };

  return {
    asOf,
    isViewingHistorical: asOf != null,
    drawerOpen: history.open,
    openHistory,
    closeHistory,
    selectedEntry: history.selectedEntry,
    selectEntry,
    auditEntries: history.auditEntries,
    loadingAudit: history.loadingAudit,
    historyError: history.error,
    restoreEntry,
    setRestoreEntry,
    handleRestored,
  };
}
