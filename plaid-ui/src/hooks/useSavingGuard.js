import { useEffect } from 'react';

// A reload or a closed tab asks first while ANY document still has writes on
// their way, whichever screen is showing.
//
// Every edit shows before the server has it, and a document's write queue
// sends it afterwards. That queue belongs to the DocumentModel, not to the
// screen: leave a document for the project's list and the model keeps sending
// what was queued. A listener that lived and died with the document's screen
// therefore went away while the writes were still out, and closing the tab from
// the list lost them with no question asked.
//
// So the question is asked here, once for the whole app. A screen holds its
// document while it is open (`useSavingGuard(doc)`), and a document it lets go
// of is kept watched until its queue has drained.

// document -> how many screens hold it right now.
const held = new Map();
// Documents no screen holds that are still sending, watched until they finish.
const draining = new Map(); // document -> unsubscribe

/** Whether any document the app has opened still has writes to send. */
export const anyDocumentSaving = () => {
  for (const doc of held.keys()) if (doc.isSaving) return true;
  for (const doc of draining.keys()) if (doc.isSaving) return true;
  return false;
};

const onBeforeUnload = (e) => {
  if (!anyDocumentSaving()) return;
  e.preventDefault();
  e.returnValue = '';
};

let listening = false;
const listen = () => {
  if (listening || typeof window === 'undefined') return;
  listening = true;
  window.addEventListener('beforeunload', onBeforeUnload);
};
const stopIfIdle = () => {
  if (!listening || held.size || draining.size) return;
  listening = false;
  window.removeEventListener('beforeunload', onBeforeUnload);
};

const stopDraining = (doc) => {
  const unsubscribe = draining.get(doc);
  if (!unsubscribe) return;
  draining.delete(doc);
  unsubscribe();
};

/**
 * Watch a document for as long as the caller holds it, and after that for as
 * long as its writes are still going out. Returns the release.
 */
const holdDocument = (doc) => {
  stopDraining(doc);
  held.set(doc, (held.get(doc) || 0) + 1);
  listen();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (held.get(doc) || 1) - 1;
    if (left > 0) {
      held.set(doc, left);
      return;
    }
    held.delete(doc);
    if (doc.isSaving && typeof doc.subscribe === 'function') {
      const unsubscribe = doc.subscribe(() => {
        if (doc.isSaving) return;
        stopDraining(doc);
        stopIfIdle();
      });
      draining.set(doc, unsubscribe);
      return;
    }
    stopIfIdle();
  };
};

/** Hold `doc` while this screen is mounted. See the note at the top. */
export const useSavingGuard = (doc) => {
  useEffect(() => (doc ? holdDocument(doc) : undefined), [doc]);
};
