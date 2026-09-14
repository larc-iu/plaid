// The provider lives in plaid-ui, shared with plaid-ud. This re-export is the
// path the app's 24 consumers import.
export { AuthProvider } from '@ui/contexts/AuthContext.jsx';
export { useAuth } from '@ui/contexts/useAuth.js';
