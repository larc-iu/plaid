import { useSyncExternalStore } from 'react';

// Signed out in another tab and back in again, this tab's clients take the new
// token in place (services/auth.js), and nothing re-renders for it. What was
// fetched with the old token and failed (a profile picture) reads this to ask
// again.
let version = 0;
const listeners = new Set();

/** Say that this tab's clients hold a new login. */
export const signedInAgain = () => {
  version += 1;
  for (const fn of listeners) fn();
};

const subscribe = (fn) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};
const current = () => version;

/** A number that changes whenever this tab takes a new login in place. */
export const useSignInAgain = () => useSyncExternalStore(subscribe, current, current);
