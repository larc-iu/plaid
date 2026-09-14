// The provider lives in plaid-ui, shared with plaid-igt. This re-export is the
// path the app's 33 consumers import.
export { AuthProvider } from '@ui/contexts/AuthContext.jsx';
export { useAuth } from '@ui/contexts/useAuth.js';
