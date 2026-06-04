import { createContext, useContext } from 'react';

// Carries the single shared IgtDocument (+ client/readOnly/asOf) for the whole
// document editor, so every tab and the Analyze island consume ONE model instead
// of each fetching their own. Tabs read `doc` getters and call `doc.method()`,
// subscribing via `useIgtDocument(doc)`; transient UI state stays component-local.
const DocumentCtx = createContext(null);

export const DocumentProvider = DocumentCtx.Provider;

export const useDocumentCtx = () => {
  const ctx = useContext(DocumentCtx);
  if (!ctx) throw new Error('useDocumentCtx must be used within a DocumentProvider');
  return ctx;
};
