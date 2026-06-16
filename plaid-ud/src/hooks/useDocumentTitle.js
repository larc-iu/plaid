import { useEffect } from 'react';

const APP_NAME = 'Plaid UD';
const SEP = ' · ';

// Sets document.title to `segments… · Plaid UD`. Falsy segments are dropped, so
// callers can pass loading-state nulls directly, e.g.
//   useDocumentTitle(doc?.name, project?.name)
// Resets to the bare app name on unmount.
export function useDocumentTitle(...segments) {
  const title = [...segments.flat().filter(Boolean), APP_NAME].join(SEP);
  useEffect(() => {
    document.title = title;
    return () => { document.title = APP_NAME; };
  }, [title]);
}
