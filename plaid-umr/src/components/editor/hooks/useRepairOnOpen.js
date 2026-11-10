import { useEffect } from 'react';
import { useReconcileOnOpen } from '@ui/hooks/useReconcileOnOpen.js';
import { useDocumentEditor } from '@ui/hooks/useDocumentEditor.js';
import { canEditProject } from '@ui/domain/permissions.js';
import { useAuth } from '../../../contexts/AuthContext.jsx';

// The repair a document gets when it opens (R3b), and the gate a tab holds
// its body behind while it runs: true until it has ended. Annotate and
// Export run it, so the Export tab opened first writes the names the repair
// gives (a sentence IGT moved renumbers its variables), as Annotate shows them.
//
// Strict mode OCC-guards the writes, as in plaid-ud: every write carries the
// document's version, so an edit made over another person's newer one is
// refused with a 409 and the page resyncs. It is entered BEFORE the repair,
// whose writes then carry the version it was planned from. It is client-
// GLOBAL, so it is exited on the way out of the tab, or it leaks onto
// unrelated writes (a copy on Details, a rename) with a stale version.
//
// The shell's tab strip is locked while the repair runs: a tab switch
// mid-repair would leave it writing under a screen that has moved on.
export function useRepairOnOpen() {
  const { documentId, liveDoc, asOf, project, setChromeBusy } = useDocumentEditor();
  const { getClient, user } = useAuth();
  const reconciling = useReconcileOnOpen({
    doc: liveDoc,
    asOf,
    canWrite: canEditProject(project, user),
    enterStrictMode: () => getClient()?.enterStrictMode(documentId),
  });
  useEffect(() => () => getClient()?.exitStrictMode(), [documentId, getClient]);
  useEffect(() => {
    setChromeBusy?.(reconciling);
    return () => setChromeBusy?.(false);
  }, [reconciling, setChromeBusy]);
  return reconciling;
}
