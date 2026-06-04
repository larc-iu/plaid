import { createContext, useContext, useMemo } from 'react';
import { useParams } from 'react-router-dom';

import PlaidClient from '@larc-iu/plaid-client';

const StrictModeContext = createContext(null);

/**
 * Provider that creates a per-document PlaidClient for the editor tabs.
 *
 * STRICT MODE IS DELIBERATELY DISABLED. The client's strict mode stamps EVERY
 * batched op's path with the same pre-batch `document-version`, so any batch
 * containing 2+ structural (version-bumping) ops 409s the moment the first op
 * bumps the version — the second op still claims the old one. That breaks every
 * multi-op batch the editor relies on: tokenize split/merge/clear-sentences
 * (bulkDelete + split/merge/bulkCreate), baseline retokenize (bulkDelete +
 * texts.update + bulkCreate), and media alignment (texts.update + tokens.create
 * + bulkCreate). Confirmed against live core: `update+create` and
 * `bulkDelete+bulkCreate` both 409 under strict mode and succeed without it.
 *
 * This is a single-user-per-document tool (see the project threat model: trusted
 * users, correctness + ACL + error-UX over concurrency hardening). A broken OCC
 * that blocks core editing is strictly worse than no OCC, so we run non-strict.
 * If OCC is wanted later, fix it in the client (stamp the batch once / let the
 * server validate the batch atomically) rather than per-op, then re-enable here.
 *
 * The hook name (`useStrictClient`) is kept to avoid churn across consumers; it
 * now simply returns the per-document client.
 */
export const StrictModeProvider = ({ children }) => {
  const { documentId } = useParams();

  const baseUrl = import.meta.env.VITE_API_URL || window.location.origin;
  const token = localStorage.getItem('token');

  // Per-document client. NOT in strict mode (see the note above).
  const documentClient = useMemo(() => {
    if (!token || !documentId) return null;
    return new PlaidClient(baseUrl, token);
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