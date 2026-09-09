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

// A page that is going away must NOT delete the pointer to a run that is still
// going: the next page finding it is the entire point.
//
// This is not hypothetical. Tearing the page down kills the request's stream,
// and the client settles the promise when that happens ("Service closed the
// connection without a result") — indistinguishable, from the caller's side,
// from the run itself ending. The run's `finally` then cleared the record on
// its way out, so the reloaded page found nothing and the run vanished from
// the UI while the service carried on writing. This flag is what tells "the
// run ended" apart from "this page ended".
let unloading = false;
if (typeof window !== 'undefined') {
  const going = () => {
    unloading = true;
  };
  window.addEventListener('pagehide', going);
  window.addEventListener('beforeunload', going);
  // `pagehide` also fires when a page goes into the back/forward cache, and
  // such a page comes back alive. Without this the flag would stay set for the
  // rest of its life and no record would ever be cleared again.
  window.addEventListener('pageshow', () => {
    unloading = false;
  });
}

// Test seam: the flag is set by real navigation, and nothing resets it, since
// a page that has begun unloading never comes back.
export function __resetUnloadingForTests() {
  unloading = false;
}

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
  if (!documentId || unloading) return;
  try {
    localStorage.removeItem(key(documentId));
  } catch {
    /* nothing to undo */
  }
}
