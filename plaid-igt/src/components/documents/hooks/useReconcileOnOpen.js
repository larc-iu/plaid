import { useEffect, useRef, useState } from 'react';
import { reportIntegrityFindings, dismissIntegrityFindings } from '@ui/lib/integrityToast.js';
import { notifyError, humanizeError } from '@/utils/feedback';

// Heal IGT invariants in the shared substrate: no morpheme may be orphaned, no
// token may carry duplicate spans or links. Runs once when the document loads,
// to repair what another app (e.g. UD) may have left. Edit permission only, not
// while time-travelling (asOf is a read-only snapshot). Idempotent and
// single-flighted.
//
// It used to re-run on every entry into the Analyze tab, because words
// tokenized this session had no morpheme yet and only reconcile made one.
// Nothing makes one now: derive gives every word a morpheme whether or not one
// is stored (virtualMorpheme.js), so a freshly tokenized word is ready to
// annotate the moment it exists, and the re-entry pass had nothing left to do.
//
// Returns `reconciling`, the gate the editor holds behind a spinner. The pass
// runs behind one rather than over a live, editable document: reconcile WRITES
// (it deletes orphans), and letting the user annotate into a document that is
// still being repaired invites edits against tokens that are about to be
// deleted.
//
// The gate reads the DOCUMENT's asOf as well as the page's: on the way back
// from history the page's asOf is already null while `doc` is still the
// snapshot, and a pass over the snapshot's data would write what was missing
// THEN into the live document, racing the pass the live document gets once it
// arrives (the loser 409s and toasts "Repair failed").
export function useReconcileOnOpen({ doc, documentId, asOf, canWrite }) {
  const reconciledDocRef = useRef(null);
  const [reconciling, setReconciling] = useState(true);

  useEffect(() => {
    // Paths with nothing to repair still have to lower the gate, or the editor
    // waits forever on a pass that will never run.
    if (!doc || asOf || doc.asOf || !canWrite) {
      if (doc) setReconciling(false);
      return undefined;
    }
    if (reconciledDocRef.current === doc) return undefined;
    reconciledDocRef.current = doc;
    let cancelled = false;
    setReconciling(true);
    (async () => {
      try {
        const {
          deleted = 0,
          deletedAnnotatedOrphans = 0,
          dedupedSpans = 0,
          dedupedLinks = 0,
          syncedMorphTypes = 0,
          findings = [],
          error,
        } = await doc.reconcileOnOpen();
        if (cancelled) return;
        // Cached morph types re-synced from their lexicon entries (an entry's
        // type changed, or an import's allomorph type differed).
        if (syncedMorphTypes) {
          console.info(
            `Reconcile: synced ${syncedMorphTypes} morpheme type(s) from lexicon entries`,
          );
        }
        // A repair that FAILED is the user's business — it's why the document
        // may still look wrong. Name the cause: "could not repair" with no
        // reason is unactionable in production, where the usual culprit is a
        // timeout or a transport error on a large document.
        if (error) {
          notifyError(
            `Could not finish auto-repairing this document; some morphemes may be missing or out of sync. Try reloading. (${humanizeError(error)})`,
            'Repair failed',
          );
          return;
        }
        // A repair that SUCCEEDED is not. The document is now correct, there is
        // nothing for the user to do, and a toast on open only teaches them to
        // dismiss toasts. The tally goes to the console, where it stays
        // available for a bug report. Failures and un-healable findings below
        // still speak up.
        if (deleted + dedupedSpans + dedupedLinks > 0) {
          const parts = [];
          if (deleted) {
            const note = deletedAnnotatedOrphans
              ? `matching no word, ${deletedAnnotatedOrphans} carrying annotations that are recoverable via document history`
              : 'matching no word';
            parts.push(`removed ${deleted} orphaned morpheme${deleted === 1 ? '' : 's'} (${note})`);
          }
          if (dedupedSpans) {
            parts.push(
              `merged ${dedupedSpans} duplicate annotation${dedupedSpans === 1 ? '' : 's'} from a token merge (values joined with ' | ')`,
            );
          }
          if (dedupedLinks) {
            parts.push(
              `removed ${dedupedLinks} extra vocabulary link${dedupedLinks === 1 ? '' : 's'} left on a merged word (a word links one entry, so the first was kept)`,
            );
          }
          console.info(`Reconcile: ${parts.join('; ')}`);
        }
        // Integrity findings (things we could NOT auto-repair) — console + toast.
        reportIntegrityFindings(findings, { documentId: doc.id });
      } catch (e) {
        console.error('Reconcile failed:', e);
      } finally {
        // Raise the gate however the pass ended — a repair that threw must not
        // strand the document behind a spinner. A CANCELLED pass deliberately
        // leaves the gate down: the run that replaces it re-arms it
        // synchronously, so clearing it here would flash the editor open in
        // between (StrictMode's double-invoke does exactly this in dev).
        if (!cancelled) setReconciling(false);
      }
    })();
    return () => {
      cancelled = true;
      // If this pass was cancelled before it could report (StrictMode's dev
      // double-invoke, a quick tab switch), let the next run happen, or the
      // integrity findings toast is never shown. reconcileOnOpen itself is
      // idempotent, so re-running is cheap.
      if (reconciledDocRef.current === doc) reconciledDocRef.current = null;
    };
  }, [doc, asOf, canWrite]);

  // The integrity toast is sticky (duration Infinity) so it isn't missed, but
  // it is about THIS document: drop it when the user leaves for another
  // document or page instead of letting it follow them around the app.
  useEffect(() => () => dismissIntegrityFindings(), [documentId]);

  return reconciling;
}
