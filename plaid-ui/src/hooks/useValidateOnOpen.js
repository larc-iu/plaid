import { useEffect, useRef } from 'react';
import { reportIntegrityFindings } from '../lib/integrityToast.js';

// The check an editor runs when a document opens: what the document's
// contract finds wrong in it (DocumentModel's `validateOnOpen`), reported to
// the person. It writes nothing (R3, 2026-10-24): what another app left is read
// right by the app's readers and stored by the next real edit. Once per
// document, for a person who can edit it, and never over a past state, which
// is not the document anyone would fix. The document's own `asOf` is read as
// well as the page's: on the way back from history the page's is already null
// while `doc` is still the snapshot.
//
// `enterStrictMode` runs once the document has loaded, on every path, so the
// edits made on the page carry the version they were planned from. An app
// whose editor client is strict from the start passes none.
export function useValidateOnOpen({ doc, asOf, canWrite, enterStrictMode }) {
  const checkedRef = useRef(null);
  const latest = useRef({});
  latest.current = { enterStrictMode };

  useEffect(() => {
    if (!doc) return;
    latest.current.enterStrictMode?.();
    if (asOf || doc.asOf || !canWrite || checkedRef.current === doc) return;
    checkedRef.current = doc;
    const { findings = [], error } = doc.validateOnOpen();
    if (error) console.error('Checking the document failed:', error);
    reportIntegrityFindings(findings, { documentId: doc.id });
  }, [doc, asOf, canWrite]);
}
