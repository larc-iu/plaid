import { useSyncExternalStore } from 'react';

const NOOP_SUBSCRIBE = () => () => {};
const NOOP_SNAPSHOT = () => 0;

// Subscribes a React component to a CommentStore's version counter. Returns the
// same store instance; reads come off `store.threads()` / `store.countFor()` /
// `store.error` / etc. Re-renders fire on every `_emit()` (load, post, edit,
// delete, live update).
//
// `subscribe` and `getSnapshot` are class arrow-field properties on
// CommentStore so their identities stay stable across renders of the same
// instance; React's useSyncExternalStore won't tear down / resubscribe
// spuriously.
//
// Mirrors useIgtDocument. Keeping the store itself framework-agnostic is what
// lets the vanilla-JS editor island read the same instance the Comments tab
// renders from.
export function useCommentStore(store) {
  useSyncExternalStore(store?.subscribe ?? NOOP_SUBSCRIBE, store?.getSnapshot ?? NOOP_SNAPSHOT);
  return store;
}
