// The one service request in flight on a document, remembered so a reloaded
// page can find it again.
//
// A request outlives the browser that made it: the service goes on, its
// progress keeps being recorded, and the result waits on the server for fifteen
// minutes (see the manual, "Presence and persistence"). What was missing was
// the id, so a fresh page had no way to ask. The client lets us MINT the id
// before submitting, which is what makes it safe to write down first and submit
// second — the alternative, learning the id from the server's `accepted` event,
// loses exactly the window a reload is most likely to fall in.
//
// Per user, per browser, because that is who reloaded the tab. It is a
// pointer, not data: losing it costs the progress display, never the work.

const key = (documentId) => `plaid_igt_run_${documentId}`;

// `multiStep` marks a run the browser was orchestrating (Auto-analyze), where
// rejoining reaches the step that was in flight and NOT the steps after it.
export function writeRunRecord(documentId, { requestId, projectId, label, multiStep = false }) {
  if (!documentId || !requestId) return;
  try {
    localStorage.setItem(
      key(documentId),
      JSON.stringify({ requestId, projectId, label, multiStep, startedAt: Date.now() }),
    );
  } catch {
    /* a blocked store only costs the resume */
  }
}

export function readRunRecord(documentId) {
  if (!documentId) return null;
  try {
    const raw = localStorage.getItem(key(documentId));
    if (!raw) return null;
    const rec = JSON.parse(raw);
    if (!rec?.requestId || !rec?.projectId) return null;
    return rec;
  } catch {
    return null;
  }
}

export function clearRunRecord(documentId) {
  if (!documentId) return;
  try {
    localStorage.removeItem(key(documentId));
  } catch {
    /* nothing to undo */
  }
}
