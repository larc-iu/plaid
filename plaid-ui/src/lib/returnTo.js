// Where a person was going when they had to sign in, so sign-in can take them
// there. Two ways in: the guard's redirect carries it in the router state, and
// a session that ends mid-work (a hard reload onto the sign-in page) keeps it in
// this tab's sessionStorage.

const KEY = 'plaid:return-to';

/** `path` when it is a path inside this app other than sign-in, else null. */
export const appPath = (path, loginPath) => {
  if (typeof path !== 'string' || !path.startsWith('/')) return null;
  // `//host` and `/\host` leave the origin.
  if (path.startsWith('//') || path.startsWith('/\\')) return null;
  if (loginPath && (path === loginPath || path.startsWith(`${loginPath}?`))) return null;
  return path;
};

/** Keep `path` for the next sign-in in this tab. */
export const rememberReturnTo = (path) => {
  try {
    if (appPath(path)) sessionStorage.setItem(KEY, path);
  } catch {
    /* storage unavailable */
  }
};

/** The kept path, which is then forgotten. */
export const takeReturnTo = () => {
  try {
    const path = sessionStorage.getItem(KEY);
    sessionStorage.removeItem(KEY);
    return path;
  } catch {
    return null;
  }
};

// Set once this page starts signing out, until it reloads. The guard renders
// once more as the user goes, and a `from` written then would send the next
// person to sign in on this tab to the last person's page.
let signingOut = false;

/** This page is signing out. */
export const markSigningOut = () => {
  signingOut = true;
};

/** Whether this page is signing out. */
export const isSigningOut = () => signingOut;
