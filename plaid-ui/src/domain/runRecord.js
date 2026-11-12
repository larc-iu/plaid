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

import { appPrefix } from '../lib/uiConfig.js';

const key = (documentId) => `${appPrefix()}_run_${documentId}`;

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
  // `pagehide` and not `beforeunload`: a page asks before it goes while a run
  // holds a document (useSavingGuard), and one whose person answered Stay is
  // not going away. Had `beforeunload` set the flag, the run that page went
  // on to finish would have left its record behind, and opening the document
  // again would have announced the run a second time, saying its later steps
  // had not run. `pagehide` comes before the page's streams are torn down.
  window.addEventListener('pagehide', () => {
    unloading = true;
  });
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

// `stepsAfter` names the steps after this one of a run the browser was
// ordering (Auto-analyze): rejoining reaches the step that was in flight and
// NOT the steps after it, which the resume names as not run.
// `step` names that step, for the resume to say it failed by its name.
// A record with no `requestId` has nothing to rejoin: Auto-analyze left during
// a built-in step or between steps, whose `stepsAfter` did not run.
// `task` is the run's task (TASKS), by which a rejoined run finds the app's
// words for its result's counts (useResumedRun).
export function writeRunRecord(
  documentId,
  { requestId, projectId, label, task = null, step = null, stepsAfter = [] },
) {
  if (!documentId) return;
  try {
    localStorage.setItem(
      key(documentId),
      JSON.stringify({
        requestId: requestId ?? null,
        projectId,
        label,
        task,
        step,
        stepsAfter,
        startedAt: Date.now(),
      }),
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
    if (!rec?.projectId) return null;
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
