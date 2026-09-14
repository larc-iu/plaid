import { createContext, useContext } from 'react';

// The context and its hook sit beside the provider rather than in it, because
// a file that exports a component may export nothing else if fast refresh is
// to work on it.
export const AuthContext = createContext(null);

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
