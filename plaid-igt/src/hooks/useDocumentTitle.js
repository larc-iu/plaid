import { useEffect } from 'react';

const APP_NAME = 'Plaid IGT';
const SEP = ' · ';

// Sets document.title to `segments… · Plaid IGT`. Falsy segments are dropped, so
// callers can pass loading-state nulls directly, e.g.
//   useDocumentTitle(doc?.document?.name, doc?.project?.name)
// Resets to the bare app name on unmount.
export function useDocumentTitle(...segments) {
  const title = [...segments.flat().filter(Boolean), APP_NAME].join(SEP);
  useEffect(() => {
    document.title = title;
    return () => { document.title = APP_NAME; };
  }, [title]);
}
