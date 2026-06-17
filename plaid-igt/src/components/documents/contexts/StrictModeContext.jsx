import { createContext, useContext, useMemo } from 'react';
import { useParams } from 'react-router-dom';

import PlaidClient from '@larc-iu/plaid-client';

import { authService } from '../../../services/auth';

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
 * Strict mode WAS disabled because it stamped every batched op with the same
 * pre-batch version, so a multi-op batch self-409'd (the 2nd op claimed the
 * version the 1st op had already bumped). That's fixed: the client stamps only
 * the FIRST write of a batch (http.js) and the server dedupes version params
 * across the batch (task #109), giving whole-batch OCC. Verified against live
 * core (e2e/alpha/occ-probe.mjs): bulkDelete+bulkCreate and update+create
 * batches succeed under strict mode, while a genuine stale single write 409s.
 *
 * The hook name (`useStrictClient`) is kept to avoid churn across consumers.
 */
export const StrictModeProvider = ({ children }) => {
  const { documentId } = useParams();

  const baseUrl = import.meta.env.VITE_API_URL || window.location.origin;
  const token = localStorage.getItem('token');

  // Per-document client, in strict mode (document-version OCC) — see the note above.
  const documentClient = useMemo(() => {
    if (!token || !documentId) return null;
    const c = new PlaidClient(baseUrl, token, {
      onAuthError: () => authService.logout(),
    });
    c.enterStrictMode(documentId);
    return c;
  }, [baseUrl, token, documentId]);

  return (
    <StrictModeContext.Provider value={documentClient}>
      {children}
    </StrictModeContext.Provider>
  );
};

/**
 * Hook to access the strict mode client.
 */
export const useStrictClient = () => {
  const strictClient = useContext(StrictModeContext);
  return strictClient;
};