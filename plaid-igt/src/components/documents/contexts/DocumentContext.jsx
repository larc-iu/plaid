import { createContext, useContext, useEffect } from 'react';

// Carries the single shared IgtDocument (+ client/readOnly/asOf) for the whole
// document editor, so every tab and the Analyze island consume ONE model instead
// of each fetching their own. Tabs read `doc` getters and call `doc.method()`,
// subscribing via `useDocumentModel(doc)`; transient UI state stays component-local.
const DocumentCtx = createContext(null);

export const DocumentProvider = DocumentCtx.Provider;

export const useDocumentCtx = () => {
  const ctx = useContext(DocumentCtx);
  if (!ctx) throw new Error('useDocumentCtx must be used within a DocumentProvider');
  return ctx;
};

/**
 * A tab's unsaved draft, told to the tab strip so that leaving asks first.
 * `what` names it in the question ("The baseline text you have typed"); null
 * while there is nothing to lose. Registered per tab, and dropped when the tab
 * goes, so the strip only ever knows about the tab that is showing.
 */
export const useUnsavedDraft = (what) => {
  const { reportUnsaved } = useDocumentCtx();
  useEffect(() => {
    reportUnsaved?.(what || null);
    return () => reportUnsaved?.(null);
  }, [reportUnsaved, what]);
  // A reload or a closed window is the browser's own question to ask, and it
  // only asks when something says there is something to lose.
  useEffect(() => {
    if (!what) return undefined;
    const onBeforeUnload = (e) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [what]);
};
