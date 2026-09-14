import { useState, useEffect } from 'react';
import { authService } from '../services/auth.js';
import { humanizeError, signInError, statusOf } from '../lib/errors.js';
import { AuthContext } from './useAuth.js';

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

  // Two ways to reach the same client, both of which callers already use.
  // `client` is null while signed out, for a screen that renders either way.
  // `getClient()` refuses instead, for a write path that has no answer without
  // one and would otherwise read a method off null several frames later.
  const getClient = () => {
    if (!client) {
      throw new Error('Not authenticated');
    }
    return client;
  };

  // A handle on the live client for the dev console. The gate is DEV, not
  // VITE_API_URL: that variable names a different API host, which a built
  // deployment may well set, and it is unset in both apps' dev configs.
  useEffect(() => {
    if (import.meta.env.DEV) {
      window.__client = client;
    }
  }, [client]);

  const value = {
    user,
    login,
    redeemInvite,
    logout,
    updateUser,
    isAuthenticated: !!user,
    loading,
    client,
    getClient,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};
