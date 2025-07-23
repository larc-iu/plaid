import { createContext, useContext, useMemo } from 'react';
import { useAuth } from './AuthContext';

// Import the PlaidClient
import '../services/plaidClient.js';
const PlaidClient = window.PlaidClient;

const StrictModeContext = createContext(null);

/**
 * Provider component that creates a new PlaidClient instance with strict mode enabled
 * for a specific document. This ensures that all operations within this context
 * will use document versioning to prevent concurrent modification conflicts.
 */
export const StrictModeProvider = ({ documentId, children }) => {
  const { user } = useAuth();
  
  // Get credentials from localStorage (same as auth service does)
  const baseUrl = import.meta.env.VITE_API_URL || window.location.origin;
  const token = localStorage.getItem('token');
  
  // Create a new client instance with strict mode enabled
  const strictClient = useMemo(() => {
    if (!token || !documentId) return null;
    
    const client = new PlaidClient(baseUrl, token);
    
    // Enter strict mode for this document
    client.enterStrictMode(documentId);

    return client;
  }, [baseUrl, token, documentId]);
  
  return (
    <StrictModeContext.Provider value={strictClient}>
      {children}
    </StrictModeContext.Provider>
  );
};

/**
 * Hook to access the strict mode client. Falls back to the regular client
 * from AuthContext if not within a StrictModeProvider.
 */
export const useStrictClient = () => {
  const { client: authClient } = useAuth();
  const strictClient = useContext(StrictModeContext);
  
  // Use strict client if available, otherwise fall back to auth client
  return strictClient || authClient;
};