// The provider lives in plaid-ui, shared with the other apps. This re-export is
// the path the app's consumers import.
export { AuthProvider } from '@ui/contexts/AuthContext.jsx';
export { useAuth } from '@ui/contexts/useAuth.js';
