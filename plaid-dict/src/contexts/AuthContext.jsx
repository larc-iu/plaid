import { createContext, useContext, useState, useEffect } from 'react';
import { authService } from '@/services/auth';

const AuthContext = createContext(null);

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within an AuthProvider');
  return context;
};

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setUser(authService.getCurrentUser());
    setLoading(false);
  }, []);

  const login = async (email, password) => {
    try {
      const result = await authService.login(email, password);
      setUser(result.user);
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message || 'Login failed' };
    }
  };

  const logout = (reason = null) => {
    authService.logout(reason);
    setUser(null);
  };

  const client = user ? authService.getClient() : null;

  if (import.meta.env.DEV) window.__client = client;

  return (
    <AuthContext.Provider value={{ user, login, logout, isAuthenticated: !!user, loading, client }}>
      {children}
    </AuthContext.Provider>
  );
};
