import { useEffect } from 'react';
import { useAuth } from '../contexts/useAuth.js';
import { loadUserKeymap } from '../lib/userKeymap.js';

/**
 * Lay the signed-in person's bindings over an app's keymap, and take them off
 * again when they sign out. Mounted once, by the app shell. A failed load
 * leaves the defaults in place: a shortcut that works beats one that is theirs.
 *
 * `null` for an app with no rebindable table of its own (plaid-ud's chords are
 * still hard-coded, by ruling), so the shell can call this unconditionally.
 */
export function useUserKeymap(keymap) {
  const { user, client } = useAuth();
  const userId = user?.id ?? null;
  useEffect(() => {
    if (!keymap) return undefined;
    if (!userId || !client) {
      keymap.setOverrides({});
      return undefined;
    }
    let live = true;
    // What was bound when the load began. A change made on the settings screen
    // before a slow load lands is newer than what the load is carrying, and is
    // already on the account.
    const before = keymap.overrides();
    loadUserKeymap(client, userId)
      .then((map) => live && keymap.overrides() === before && keymap.setOverrides(map))
      .catch((e) => console.error('Could not load keyboard shortcuts:', e));
    return () => {
      live = false;
      // The shell unmounts at sign-out, so this is where one person's bindings
      // come off before the next person signs in on the same tab.
      keymap.setOverrides({});
    };
  }, [keymap, userId, client]);
}
