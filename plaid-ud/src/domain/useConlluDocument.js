import { useSyncExternalStore } from 'react';

const NOOP_SUBSCRIBE = () => () => {};
const NOOP_SNAPSHOT = () => 0;

// Subscribes a React component to a ConlluDocument's version counter.
// Returns the same doc instance; reads come off `doc.sentences` /
// `doc.layerInfo` / `doc.isSaving` / `doc.error` / `doc.toConllu()`.
// Re-renders fire on every `_emit()` (mutation, error change, reload).
//
// `subscribe` and `getSnapshot` are class arrow-field properties on
// ConlluDocument so their identities stay stable across renders of the
// same doc instance; React's useSyncExternalStore won't tear down /
// resubscribe spuriously.
export function useConlluDocument(doc) {
  useSyncExternalStore(
    doc?.subscribe ?? NOOP_SUBSCRIBE,
    doc?.getSnapshot ?? NOOP_SNAPSHOT
  );
  return doc;
}
