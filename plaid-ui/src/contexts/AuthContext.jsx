import { useState, useEffect } from 'react';
import { authService } from '../services/auth.js';
import { humanizeError, signInError, statusOf } from '../lib/errors.js';
import { AuthContext } from './useAuth.js';
import { t } from '../lib/i18n.js';

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Check if user is already logged in
    const currentUser = authService.getCurrentUser();
    if (currentUser) {
      setUser(currentUser);
      // isAdmin was cached at sign-in. An admin switched off since must lose
      // the admin screens on the next load, not at the next sign-in. A read
      // that fails, or is not made, keeps the cached value.
      authService.refreshAccount(currentUser.id).then((account) => {
        if (!account) return;
        const isAdmin = !!account.isAdmin;
        if (isAdmin === !!currentUser.isAdmin) return;
        localStorage.setItem('isAdmin', isAdmin.toString());
        setUser((u) => (u?.id === currentUser.id ? { ...u, isAdmin } : u));
      });
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
      return { success: true, projectId: result.projectId };
    } catch (error) {
      return {
        success: false,
        status: error.status,
        error:
          statusOf(error) === 404
            ? t('This invitation link is not valid.')
            : humanizeError(error, t('Failed to redeem this invite.')),
      };
    }
  };

  // `reason` ('expired', 'password-changed') lets the login page say why it is showing.
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
