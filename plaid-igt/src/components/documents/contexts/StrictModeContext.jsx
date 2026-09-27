import { createContext, useContext, useMemo } from 'react';
import { useParams } from 'react-router-dom';

import { authService } from '@ui/services/auth.js';

const StrictModeContext = createContext(null);

/**
 * Provider that creates a per-document PlaidClient for the editor tabs, in
 * STRICT MODE (document-version OCC).
 *
 * A stale write — a second tab or a second user editing the same document —
 * now 409s with a clear "this changed elsewhere, reload" message instead of
 * silently clobbering the other writer's work. This tool is still
 * single-user-per-document by design; OCC just makes a violation loud rather
 * than silent.
 *
 * OCC over a batch is whole-batch: the client stamps a batch's one expected
 * version onto the first write queued on it (http.js) and the server dedupes
 * version params across the batch, so a multi-op batch cannot 409 against the
 * bump its own first op caused. A write made on the client carries its own
 * stamp.
 *
 * The hook name (`useStrictClient`) is kept to avoid churn across consumers.
 */
export const StrictModeProvider = ({ children }) => {
  const { documentId } = useParams();

  // This tab's session. localStorage's token belongs to whichever tab signed in
  // last, which may be another user, so it is never read here.
  const session = authService.getClient();

  // Per-document client, in strict mode (document-version OCC) — see the note
  // above. The session makes it, on the session's token, so a 401 on it is
  // answered the way every other client's is (a refused write keeps the page,
  // see services/auth.js).
  const documentClient = useMemo(() => {
    if (!session || !documentId) return null;
    const c = authService.newClient();
    c.enterStrictMode(documentId);
    return c;
  }, [session, documentId]);

  return <StrictModeContext.Provider value={documentClient}>{children}</StrictModeContext.Provider>;
};

/**
 * Hook to access the strict mode client.
 */
export const useStrictClient = () => {
  const strictClient = useContext(StrictModeContext);
  return strictClient;
};
