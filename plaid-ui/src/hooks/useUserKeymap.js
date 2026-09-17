import { useEffect } from 'react';
import { useAuth } from '../contexts/useAuth.js';
import { loadUserKeymap } from '../lib/userKeymap.js';

/**
 * Lay the signed-in person's bindings over an app's keymap, and take them off
 * again when they sign out. Mounted once, by the app shell. A failed load
 * leaves the defaults in place: a shortcut that works beats one that is theirs.
 */
export function useUserKeymap(keymap) {
  const { user, client } = useAuth();
  const userId = user?.id ?? null;
  useEffect(() => {
    if (!userId || !client) {
      keymap.setOverrides({});
      return undefined;
    }
    let live = true;
    loadUserKeymap(client, userId)
      .then((map) => live && keymap.setOverrides(map))
      .catch((e) => console.error('Could not load keyboard shortcuts:', e));
    return () => {
      live = false;
    };
  }, [keymap, userId, client]);
}
