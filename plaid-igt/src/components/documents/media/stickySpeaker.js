import { useSyncExternalStore } from 'react';

// Sticky speaker for fast diarization: a new segment defaults to the speaker of
// the segment saved last in the same document, so labeling a run of
// same-speaker turns is one keystroke (just save). One value per document, for
// the session: a speaker typed in one document is no default for the next, and
// a document nothing was saved in yet starts with none. The persisted truth is
// the token metadata plus the project speaker cache. Shared by the timeline
// popover and the transcript list so the default follows the user between the
// two.
const lastSpeaker = new Map(); // document id -> speaker
const listeners = new Set();

export const getStickySpeaker = (documentId) => lastSpeaker.get(documentId) ?? '';

export const setStickySpeaker = (documentId, speaker) => {
  lastSpeaker.set(documentId, (speaker || '').trim());
  for (const listener of listeners) listener();
};

const subscribe = (listener) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** The document's sticky speaker, drawn again whenever a save changes it. */
export const useStickySpeaker = (documentId) =>
  useSyncExternalStore(subscribe, () => getStickySpeaker(documentId));
