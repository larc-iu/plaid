// The media upload under way on a document, kept with the document rather
// than with the Media tab: the send lives in the document's write queue, so a
// tab mounted while it goes (after a visit to another tab) shows the same bar
// and the same Cancel, and takes no second file. `{ name, loaded, total,
// perSpeaker, abort, model }`, `abort` being the upload's AbortController and
// `model` the DocumentModel that sends it, else null. While the recording is
// still being converted for the upload it is `{ converting: true, name,
// fraction, abort, model }`.
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
    entry = { upload: null, ended: null, listeners: new Set() };
    entries.set(key, entry);
  }
  return entry;
};

// An entry with nothing to say and nobody listening is dropped, so the list
// holds only the documents on screen, uploading, or with an end not yet seen.
const tidy = (doc) => {
  if (doc.asOf) return;
  const entry = live.get(doc.document.id);
  if (entry && !entry.upload && !entry.ended && !entry.listeners.size) {
    live.delete(doc.document.id);
  }
};

export const uploadOf = (doc) => entryOf(doc).upload;

// Ending an upload leaves the model that sent it as `ended`, for
// `takeEndedBy`.
export function setUpload(doc, upload) {
  const entry = entryOf(doc);
  if (!upload && entry.upload) entry.ended = entry.upload.model;
  entry.upload = upload;
  entry.listeners.forEach((listener) => listener());
  tidy(doc);
}

// The model whose upload on this document ended since this was last asked,
// else null. The recording was written through that model, so another model
// of the document (it was left and opened again meanwhile) has to read the
// document to show it, whether its Media tab was open at the end or not.
export function takeEndedBy(doc) {
  const entry = entryOf(doc);
  const model = entry.ended;
  entry.ended = null;
  tidy(doc);
  return model;
}

export function subscribeUpload(doc, listener) {
  const entry = entryOf(doc);
  entry.listeners.add(listener);
  return () => {
    entry.listeners.delete(listener);
    tidy(doc);
  };
}
