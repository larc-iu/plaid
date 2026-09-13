import { useEffect } from 'react';

import { appName } from '../lib/uiConfig.js';

const SEP = ' · ';

// Sets document.title to `segments… · <the app's name>`. Falsy segments are
// dropped, so callers can pass loading-state nulls directly, e.g.
//   useDocumentTitle(doc?.document?.name, doc?.project?.name)
// Resets to the bare app name on unmount.
export function useDocumentTitle(...segments) {
  const title = [...segments.flat().filter(Boolean), appName()].join(SEP);
  useEffect(() => {
    document.title = title;
    return () => {
      document.title = appName();
    };
  }, [title]);
}
