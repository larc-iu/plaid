import { useSyncExternalStore } from 'react';

const NOOP_SUBSCRIBE = () => () => {};
const NOOP_SNAPSHOT = () => 0;

// Subscribes a React component to an IgtDocument's version counter. Returns
// the same doc instance; reads come off `doc.sentences` / `doc.layerInfo` /
// `doc.alignmentTokens` / `doc.isSaving` / `doc.error` / etc. Re-renders fire
// on every `_emit()` (mutation, error change, reload).
//
// `subscribe` and `getSnapshot` are class arrow-field properties on
// IgtDocument so their identities stay stable across renders of the same
// instance; React's useSyncExternalStore won't tear down / resubscribe
// spuriously.
//
// This is the only file under src/domain/ that imports React. Keep the doc
// class itself framework-agnostic so it can drive a vanilla-JS editor island.
export function useIgtDocument(doc) {
  useSyncExternalStore(
    doc?.subscribe ?? NOOP_SUBSCRIBE,
    doc?.getSnapshot ?? NOOP_SNAPSHOT
  );
  return doc;
}
