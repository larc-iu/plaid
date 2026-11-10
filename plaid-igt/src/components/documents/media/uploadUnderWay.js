// The media upload under way on a document, kept with the document rather
// than with the Media tab: the send lives in the document's write queue, so a
// tab mounted while it goes (after a visit to another tab) shows the same bar
// and the same Cancel, and takes no second file. `{ name, loaded, total,
// perSpeaker, abort, model }`, `abort` being the upload's AbortController and
// `model` the DocumentModel that sends it, else null.
//
// Kept by the document's id, not by its model: leaving the document for the
// project's list and coming back loads it again as another model, while the
// first one's queue goes on sending. A version from History is the same
// document as it was, and has no upload: it is kept by its own model.

const live = new Map();
const past = new WeakMap();

const entryOf = (doc) => {
  const [entries, key] = doc.asOf ? [past, doc] : [live, doc.document.id];
  let entry = entries.get(key);
  if (!entry) {
    entry = { upload: null, listeners: new Set() };
    entries.set(key, entry);
  }
  return entry;
};

// An entry with no upload and nobody listening is dropped, so the list holds
// only the documents on screen or uploading.
const tidy = (doc) => {
  if (doc.asOf) return;
  const entry = live.get(doc.document.id);
  if (entry && !entry.upload && !entry.listeners.size) live.delete(doc.document.id);
};

export const uploadOf = (doc) => entryOf(doc).upload;

export function setUpload(doc, upload) {
  const entry = entryOf(doc);
  entry.upload = upload;
  entry.listeners.forEach((listener) => listener());
  tidy(doc);
}

export function subscribeUpload(doc, listener) {
  const entry = entryOf(doc);
  entry.listeners.add(listener);
  return () => {
    entry.listeners.delete(listener);
    tidy(doc);
  };
}
