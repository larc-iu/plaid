import { useEffect, useRef, useState } from 'react';
import { reportIntegrityFindings } from '../lib/integrityToast.js';
import { humanizeError, isUnknownOutcome, statusOf } from '../lib/errors.js';
import { notifyError } from '../lib/notify.js';

// How long one request of a repair may wait for its answer before the repair
// gives up. A repair is small, and the editor is shut behind the gate while it
// runs. A request that lands after the repair gave up carries the version the
// repair was planned from, so it is refused when anything changed since.
export const REPAIR_TIMEOUT_MS = 30000;

const REPAIR_FAILED = 'Failed to repair the document';
const withStop = (text) => (/[.!?]$/.test(text) ? text : `${text}.`);

// What a repair that failed says. A conflict (409) is another person's edit
// landing between the read the repair was planned from and its write, twice
// over, since the first one is re-read and re-planned. A repair that timed out
// is no change of the user's, so the general "may or may not have been saved"
// does not fit it.
export const repairFailure = (error) => {
  if (statusOf(error) === 409) {
    return 'The document changed while it was being checked. Reload to check it again.';
  }
  if (isUnknownOutcome(error)) {
    return 'The server did not answer in time. Reload to check the document again.';
  }
  return `${withStop(humanizeError(error))} Reload to check the document again.`;
};

// The client's batch timeout, lowered while a repair runs on it. Counted per
// client, since StrictMode's double invoke shares one pass between two runs
// and the first to end must not restore the timeout under the second.
const lowered = new WeakMap();
async function withRepairTimeout(client, run) {
  if (!client) return run();
  const held = lowered.get(client);
  if (held) held.count += 1;
  else {
    lowered.set(client, { count: 1, saved: client.batchTimeout });
    client.batchTimeout = REPAIR_TIMEOUT_MS;
  }
  try {
    return await run();
  } finally {
    const h = lowered.get(client);
    h.count -= 1;
    if (h.count === 0) {
      client.batchTimeout = h.saved;
      lowered.delete(client);
    }
  }
}

// The gate an editor holds behind a spinner while the document heals what
// another app may have left in the shared substrate (DocumentModel's
// `reconcileOnOpen`). Runs once per document instance when it loads. Edit
// permission only, and never over a snapshot. Idempotent and single-flighted.
//
// The pass runs behind a gate rather than over a live, editable document:
// reconcile WRITES (it deletes orphans, seeds words), and letting the user
// annotate into a document that is still being repaired invites edits against
// tokens that are about to be deleted.
//
// The gate reads the DOCUMENT's asOf as well as the page's: on the way back
// from history the page's asOf is already null while `doc` is still the
// snapshot, and a pass over the snapshot's data would write what was missing
// THEN into the live document, racing the pass the live document gets once it
// arrives (the loser 409s and toasts "Repair failed").
//
// Silent on success, loud on failure. A repair that worked leaves a correct
// document and nothing for the user to do, so its tally goes to the console
// only, where it stays available for a bug report. A repair that FAILED, and
// an invariant it could not heal at all (`findings`), both still interrupt:
// those are the cases where the document is still wrong.
//
// `enterStrictMode` runs once the document has loaded, before the pass and on a
// path with nothing to repair. The repair's own writes are then stamped with the
// version the document was read at, which is the version the repair was planned
// from: an edit someone saved in between refuses the repair (409) instead of the
// repair writing offsets that edit moved. On a 409 the document is re-read and
// the repair planned again, once. igt's editor client is strict from the start,
// so it passes none.
//
// `onFailed` hears the error of a repair that failed, for a screen whose empty
// state would otherwise misread what is missing.
export function useReconcileOnOpen({ doc, asOf, canWrite, enterStrictMode, onFailed }) {
  const reconciledDocRef = useRef(null);
  const [reconciling, setReconciling] = useState(true);
  const latest = useRef({});
  latest.current = { enterStrictMode, onFailed };

  useEffect(() => {
    // Paths with nothing to repair still have to lower the gate, or the editor
    // waits forever on a pass that will never run.
    if (!doc) return undefined;
    latest.current.enterStrictMode?.();
    if (asOf || doc.asOf || !canWrite) {
      setReconciling(false);
      return undefined;
    }
    if (reconciledDocRef.current === doc) return undefined;
    reconciledDocRef.current = doc;
    let cancelled = false;
    setReconciling(true);
    const repair = () => withRepairTimeout(doc.client, () => doc.reconcileOnOpen());
    (async () => {
      try {
        let result = await repair();
        if (cancelled) return;
        // Someone saved between the read the repair was planned from and its
        // write. Read again and plan again, once.
        if (result.error && statusOf(result.error) === 409) {
          try {
            await doc.reload();
            if (cancelled) return;
            result = await repair();
          } catch (error) {
            result = { findings: [], error };
          }
          if (cancelled) return;
        }
        // A repair that FAILED is the user's business: it is why the document
        // may still look wrong. Name the cause. In production the usual one is
        // a timeout or a transport error on a large document.
        if (result.error) {
          console.error('Repair on open failed:', result.error);
          notifyError(repairFailure(result.error), REPAIR_FAILED);
          latest.current.onFailed?.(result.error);
          return;
        }
        const line = doc.describeReconcile(result);
        if (line) console.info(line);
        // The repair is saved, and the screen still shows the document as it
        // was before it.
        if (result.refreshError) {
          notifyError(
            `${withStop(humanizeError(result.refreshError))} Try reloading.`,
            'Failed to reload the repaired document',
          );
          return;
        }
        // What the repair could NOT heal, which is why it interrupts.
        reportIntegrityFindings(result.findings || [], { documentId: doc.id });
      } catch (e) {
        console.error('Reconcile failed:', e);
      } finally {
        // Raise the gate however the pass ended: a repair that threw must not
        // strand the document behind a spinner. A CANCELLED pass deliberately
        // leaves the gate down: the run that replaces it re-arms it
        // synchronously, so clearing it here would flash the editor open in
        // between (StrictMode's double invoke does exactly this in dev).
        if (!cancelled) setReconciling(false);
      }
    })();
    return () => {
      cancelled = true;
      // If this pass was cancelled before it could report (StrictMode's dev
      // double invoke, a quick tab switch), let the next run happen, or the
      // integrity findings are never shown. reconcileOnOpen itself is
      // idempotent, so re-running is cheap.
      if (reconciledDocRef.current === doc) reconciledDocRef.current = null;
    };
  }, [doc, asOf, canWrite]);

  return reconciling;
}
