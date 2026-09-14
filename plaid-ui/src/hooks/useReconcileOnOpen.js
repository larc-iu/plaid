import { useEffect, useRef, useState } from 'react';
import { reportIntegrityFindings } from '../lib/integrityToast.js';
import { humanizeError } from '../lib/errors.js';
import { notifyError } from '../lib/notify.js';

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
// `onRepaired` runs once the pass has ended, before the gate comes down, and
// on a path with nothing to repair: the place to enter strict mode, which must
// follow the repair's own writes and precede the first edit.
export function useReconcileOnOpen({ doc, asOf, canWrite, onRepaired }) {
  const reconciledDocRef = useRef(null);
  const [reconciling, setReconciling] = useState(true);
  const latest = useRef({});
  latest.current = { onRepaired };

  useEffect(() => {
    // Paths with nothing to repair still have to lower the gate, or the editor
    // waits forever on a pass that will never run.
    if (!doc || asOf || doc.asOf || !canWrite) {
      if (doc) {
        latest.current.onRepaired?.();
        setReconciling(false);
      }
      return undefined;
    }
    if (reconciledDocRef.current === doc) return undefined;
    reconciledDocRef.current = doc;
    let cancelled = false;
    setReconciling(true);
    (async () => {
      try {
        const result = await doc.reconcileOnOpen();
        if (cancelled) return;
        // A repair that FAILED is the user's business: it is why the document
        // may still look wrong. Name the cause. In production the usual one is
        // a timeout or a transport error on a large document.
        if (result.error) {
          notifyError(
            `Could not auto-repair this document. Try reloading. (${humanizeError(result.error)})`,
            'Repair failed',
          );
          return;
        }
        const line = doc.describeReconcile(result);
        if (line) console.info(line);
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
        if (!cancelled) {
          latest.current.onRepaired?.();
          setReconciling(false);
        }
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
