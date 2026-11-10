// The media upload under way on a document, kept with the document rather
// than with the Media tab: the send lives in the document's write queue, so a
// tab mounted while it goes (after a visit to another tab) shows the same bar
// and the same Cancel, and takes no second file. `{ name, loaded, total,
// perSpeaker, abort }`, `abort` being the upload's AbortController, else null.

const uploads = new WeakMap();

const entryOf = (doc) => {
  let entry = uploads.get(doc);
  if (!entry) {
    entry = { upload: null, listeners: new Set() };
    uploads.set(doc, entry);
  }
  return entry;
};

export const uploadOf = (doc) => entryOf(doc).upload;

export function setUpload(doc, upload) {
  const entry = entryOf(doc);
  entry.upload = upload;
  entry.listeners.forEach((listener) => listener());
}

export function subscribeUpload(doc, listener) {
  const { listeners } = entryOf(doc);
  listeners.add(listener);
  return () => listeners.delete(listener);
}
