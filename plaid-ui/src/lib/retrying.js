// What a save-status pill says while a write is being sent again and again:
// the browser has no network, or it has and the server gives no answer.
// Imports nothing.

export const retryingText = () =>
  globalThis.navigator?.onLine === false ? 'Offline, retrying' : "Can't reach the server, retrying";
