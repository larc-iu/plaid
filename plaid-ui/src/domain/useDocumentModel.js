import { useSyncExternalStore } from 'react';

const NOOP_SUBSCRIBE = () => () => {};
const NOOP_SNAPSHOT = () => 0;

// Subscribes a React component to a document's version counter (any
// DocumentModel: an IgtDocument, a ConlluDocument). Returns the same instance;
// reads come off its getters. Re-renders fire on every `_emit()` (mutation,
// error change, reload).
//
// `subscribe` and `getSnapshot` are class arrow-field properties on
// DocumentModel so their identities stay stable across renders of the same
// instance; React's useSyncExternalStore won't tear down and resubscribe
// spuriously. Mirrors useCommentStore.
export function useDocumentModel(doc) {
  useSyncExternalStore(doc?.subscribe ?? NOOP_SUBSCRIBE, doc?.getSnapshot ?? NOOP_SNAPSHOT);
  return doc;
}
