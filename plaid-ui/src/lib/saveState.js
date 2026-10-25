import { retryingText } from './retrying.js';

// Where an open document's saves stand, read from DocumentModel's `isSaving`,
// `isOffline` and `isLocked` (or anything shaped like them, such as igt's
// vocabulary queues). `offline`: a write or a refetch is being sent again
// until the server answers. `locked`: a write waits for another writer's lock
// on the document to go. `saving`: a write is on its way. `idle`: nothing is.
export const saveStateOf = (doc) => {
  if (!doc?.isSaving) return 'idle';
  if (doc.isOffline) return 'offline';
  if (doc.isLocked) return 'locked';
  return 'saving';
};

// What a status says for each state. `saved` is the island's own short flash
// after a save lands, which saveStateOf never answers. The retrying words
// name the browser's network, so they are read when shown.
const WORDS = {
  saving: () => 'Saving…',
  offline: retryingText,
  locked: () => 'In use elsewhere, waiting',
  saved: () => 'Saved ✓',
};

export const saveStateText = (state) => WORDS[state]?.() ?? '';
