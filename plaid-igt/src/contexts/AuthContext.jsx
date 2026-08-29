import { createContext, useContext, useState, useEffect } from 'react';
import { authService } from '../services/auth';

const AuthContext = createContext(null);

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Check if user is already logged in
    const currentUser = authService.getCurrentUser();
    if (currentUser) {
      setUser(currentUser);
    }
    setLoading(false);
  }, []);

  const login = async (email, password) => {
    try {
      const result = await authService.login(email, password);
      setUser(result.user);
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error.message || 'Login failed',
      };
    }
  };

  const redeemInvite = async (code, credentials) => {
    try {
      const result = await authService.redeemInvite(code, credentials);
      setUser(result.user);
      return { success: true };
    } catch (error) {
      return {
        success: false,
        status: error.status,
        error: error.message || 'Could not redeem this invite',
      };
    }
  };

  // `reason` ('expired') lets the login page say why it is showing.
  const logout = (reason = null) => {
    authService.logout(reason);
    setUser(null);
  };

  const updateUser = (updates) => {
    if (user) {
      const updatedUser = { ...user, ...updates };
      setUser(updatedUser);
      // Also update localStorage if isAdmin changes
      if ('isAdmin' in updates) {
        localStorage.setItem('isAdmin', (updates.isAdmin || false).toString());
      }
      if ('avatarHash' in updates) {
        localStorage.setItem('avatarHash', updates.avatarHash || '');
      }
    }
  };

  const client = user ? authService.getClient() : null;

  // Make available in console during dev
  if (import.meta.env.VITE_API_URL) {
    window.__client = client;
  }

  const value = {
    user,
    login,
    redeemInvite,
    logout,
    updateUser,
    isAuthenticated: !!user,
    loading,
    client,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};
