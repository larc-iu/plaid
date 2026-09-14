import { createContext, useContext, useState, useEffect } from 'react';
import { authService } from '@ui/services/auth.js';
import { humanizeError, signInError, statusOf } from '@ui/lib/errors.js';

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
      return { success: false, error: signInError(error) };
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
        error:
          statusOf(error) === 404
            ? 'This invitation link is not valid.'
            : humanizeError(error, 'Could not redeem this invite.'),
      };
    }
  };

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

  const value = {
    user,
    login,
    redeemInvite,
    logout,
    updateUser,
    isAuthenticated: !!user,
    loading,
    getClient: () => {
      if (!user) {
        throw new Error('Not authenticated');
      }
      return authService.getClient();
    },
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};
