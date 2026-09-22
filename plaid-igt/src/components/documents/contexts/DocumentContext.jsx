import { createContext, useContext } from 'react';

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

// A tab's unsaved draft. It used to be this app's own hook, reaching the tab
// strip through the context above; it is the shared one now, so a link, the
// browser's Back and the tab strip all ask the same question. Re-exported here
// because a tab reads it beside `useDocumentCtx`.
export { useUnsavedDraft } from '@ui/hooks/useUnsavedDraft.js';
