import { useRef, useState } from 'react';
import { useDocumentHistory } from './useDocumentHistory.js';

// Time travel: the history drawer, the entry being viewed, and the restore it
// can lead to. One concern with four pieces of state that only make sense
// together, which is why it is a hook rather than four `useState`s in the
// middle of the editor.
//
// `getClient` and `reload` come from the screen, because both of them are about
// the LIVE document rather than the historical one.
//
// The members are spelled as plaid-igt's hook of the same name spells them
// (`drawerOpen`, `selectedEntry` / `selectEntry`, `isViewingHistorical`), since
// it is the same concept on the other app's editor. The two differ in how the
// past state is held and nowhere else: igt swaps its shared document for the
// snapshot at an `asOf`, and this one reads a separate `historicalDocument`
// beside the live one.
export function useHistoryView({ documentId, getClient, reload }) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [selectedEntry, setSelectedEntry] = useState(null);
  const [isViewingHistorical, setIsViewingHistorical] = useState(false);
  // The history entry a restore is being confirmed for.
  const [restoreEntry, setRestoreEntry] = useState(null);
  // Which selection the screen is answering. An as-of read is a round trip a
  // reader can outrun by clicking another entry, or by coming back to the
  // current state: whatever the overtaken read has to say is about a screen
  // nobody is looking at, so it must neither open a historical view that was
  // left nor roll back a selection made after it.
  const selection = useRef(0);

  const {
    auditEntries,
    historicalDocument,
    loadingAudit,
    loadingHistorical,
    hasLoadedAudit,
    error: historyError,
    fetchHistoricalDocument,
    clearHistoricalDocument,
    fetchAuditLog,
  } = useDocumentHistory(documentId);

  const openHistory = () => {
    setDrawerOpen(true);
    // Fetch audit log only when drawer is first opened
    if (!hasLoadedAudit) {
      fetchAuditLog();
    }
  };

  const selectEntry = async (entry) => {
    const mine = ++selection.current;
    if (!entry) {
      // Return to current state
      setSelectedEntry(null);
      setIsViewingHistorical(false);
      clearHistoricalDocument();
      // The as-of GET poisoned the client's strict-mode document-version tracker
      // with the OLD (historical) version. Refresh it from the live doc so the
      // next edit doesn't fail OCC with a spurious 409.
      const client = getClient();
      if (client) client.documents.get(documentId).catch(() => {});
      return;
    }

    // Set selected entry immediately for instant feedback
    const previousEntry = selectedEntry;
    setSelectedEntry(entry);

    // Fetch historical document in background
    const historicalDoc = await fetchHistoricalDocument(entry.time);
    if (mine !== selection.current) return; // another entry, or the live doc, was asked for since
    if (historicalDoc) {
      setIsViewingHistorical(true);
    } else {
      // Time travel failed (the hook already toasts). Roll the selection back
      // so the drawer doesn't show a phantom-selected entry whose state never
      // loaded — keep showing whatever we were actually viewing before.
      setSelectedEntry(previousEntry);
    }
  };

  const closeHistory = () => {
    setDrawerOpen(false);
    // Auto-return to current state when closing drawer
    if (selectedEntry) {
      selectEntry(null);
    }
  };

  // After a restore (or an undo of one) the live document has changed under
  // us and the history has a new entry. Leave the historical view, then reload
  // both. Called from the toast's Undo too, long after the dialog has closed.
  const handleRestored = async () => {
    if (selectedEntry) await selectEntry(null);
    await Promise.all([reload(), fetchAuditLog()]);
  };

  return {
    drawerOpen,
    openHistory,
    closeHistory,
    selectedEntry,
    selectEntry,
    isViewingHistorical,
    historicalDocument,
    auditEntries,
    loadingAudit,
    loadingHistorical,
    historyError,
    restoreEntry,
    setRestoreEntry,
    handleRestored,
  };
}
