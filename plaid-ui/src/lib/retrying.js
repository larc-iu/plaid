// What a save-status pill says while a write is being sent again and again:
// the browser has no network, or it has and the server gives no answer.
// Nothing about the document changes while a send is retried, so a pill
// repaints on the browser's `online` and `offline` events (`onOnlineChange`)
// to keep the wording true.
// Imports nothing.

export const retryingText = () =>
  globalThis.navigator?.onLine === false ? 'Offline, retrying' : "Can't reach the server, retrying";

/** Run `fn` when the browser goes offline or comes back. Returns the unsubscribe. */
export const onOnlineChange = (fn) => {
  globalThis.addEventListener?.('online', fn);
  globalThis.addEventListener?.('offline', fn);
  return () => {
    globalThis.removeEventListener?.('online', fn);
    globalThis.removeEventListener?.('offline', fn);
  };
};

/** Whether the browser says it has a network, for `useSyncExternalStore`. */
export const isOnline = () => globalThis.navigator?.onLine !== false;
