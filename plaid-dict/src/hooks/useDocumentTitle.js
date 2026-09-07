import { useEffect } from 'react';

const APP_NAME = 'Plaid Dictionary';
const SEP = ' · ';

// Sets document.title to `segments… · Plaid Dictionary`. Falsy segments are
// dropped, so callers can pass loading-state nulls directly.
export function useDocumentTitle(...segments) {
  const title = [...segments.flat().filter(Boolean), APP_NAME].join(SEP);
  useEffect(() => {
    document.title = title;
    return () => {
      document.title = APP_NAME;
    };
  }, [title]);
}
