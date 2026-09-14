import { useRef, useState } from 'react';
import { notifyError } from '../lib/notify.js';
import { isExpiredSession, useDocumentHistory } from './useDocumentHistory.js';

// Time travel on a document editor: the history rail, the entry being viewed,
// and the restore it can lead to. One concern with a handful of pieces of state
// that only make sense together, which is why it is a hook rather than several
// `useState`s in the middle of an editor. Both apps' editors mount it.
//
// The live document stays where it is. A snapshot is a second document object
// read beside it (`doc.atAsOf(time)`, which every document model answers with a
// new instance of itself at that time), and the screen shows `snapshot ?? doc`.
// So the way back to the live state costs no read, a snapshot that never loads
// leaves nothing to undo, and the editor never blanks to a spinner. `reload`
// refreshes the LIVE document in place after a restore: a fresh one would
// rebuild the grid and throw away the reader's position in a document they
// have just changed.
//
// Two facts, deliberately separate: `selectedEntry` is what the reader asked
// for and flips the instant they click, and the snapshot is what is on screen
// and lands when its read does. Read-only gating and the banner key on the
// first, so no edit can land on the live document in the window between.
//
// `onExpired` is called when a read comes back unauthenticated, the snapshot's
// here and the entry list's in useDocumentHistory.
export function useHistoryView({ documentId, client, doc, reload, onExpired }) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [selectedEntry, setSelectedEntry] = useState(null);
  const [snapshot, setSnapshot] = useState(null);
  const [loadingSnapshot, setLoadingSnapshot] = useState(false);
  // The history entry a restore is being confirmed for (RestoreDialog).
  const [restoreEntry, setRestoreEntry] = useState(null);
  // Which selection the screen is answering. An as-of read is a round trip a
  // reader can outrun by clicking another entry, or by coming back to the live
  // state: whatever the overtaken read has to say is about a screen nobody is
  // looking at, so it must neither open a snapshot that was left nor roll back
  // a selection made after it.
  const selection = useRef(0);
  // The entry whose snapshot is on screen: where a failed read rolls the
  // selection back to. Not `selectedEntry`, which may name a read still out.
  const shown = useRef(null);
  // Read at call time. Every screen passes these inline, and a restore's Undo
  // calls back from a toast long after the render that armed it.
  const latest = useRef({});
  latest.current = { doc, reload, onExpired, selectedEntry };

  const history = useDocumentHistory({ documentId, client, onExpired });

  const openHistory = () => {
    setDrawerOpen(true);
    if (!history.hasLoadedAudit) history.fetchAuditLog();
  };

  const selectEntry = async (entry) => {
    const mine = ++selection.current;
    setSelectedEntry(entry);
    if (!entry) {
      shown.current = null;
      setSnapshot(null);
      setLoadingSnapshot(false);
      return;
    }
    const { doc: live } = latest.current;
    if (!live) return;
    setLoadingSnapshot(true);
    try {
      const next = await live.atAsOf(entry.time);
      if (mine !== selection.current) return;
      shown.current = entry;
      setSnapshot(next);
    } catch (err) {
      if (mine !== selection.current) return;
      if (isExpiredSession(err)) {
        latest.current.onExpired?.();
        return;
      }
      console.error('Failed to load snapshot:', err);
      // Keep showing what is on screen, and put the rail back where the view
      // actually is.
      notifyError(err, 'That snapshot could not be loaded');
      setSelectedEntry(shown.current);
    } finally {
      if (mine === selection.current) setLoadingSnapshot(false);
    }
  };

  const closeHistory = () => {
    setDrawerOpen(false);
    if (selectedEntry) selectEntry(null);
  };

  // After a restore (or an undo of one) the live document has changed and the
  // rail has a new newest entry: leave the snapshot, then re-read both.
  const handleRestored = async () => {
    if (latest.current.selectedEntry) await selectEntry(null);
    await Promise.all([latest.current.reload(), history.fetchAuditLog()]);
  };

  return {
    drawerOpen,
    openHistory,
    closeHistory,
    selectedEntry,
    selectEntry,
    snapshot,
    asOf: snapshot?.asOf ?? null,
    isViewingHistorical: snapshot != null,
    loadingSnapshot,
    auditEntries: history.auditEntries,
    loadingAudit: history.loadingAudit,
    historyError: history.error,
    restoreEntry,
    setRestoreEntry,
    handleRestored,
  };
}
