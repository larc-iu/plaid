import PlaidClient from '@larc-iu/plaid-client';
import { toast } from 'sonner';
import { notifySuccess, notifyWithAction } from '../lib/notify.js';
import { hasUnsavedDraft } from '../hooks/useUnsavedDraft.js';
import { anyDocumentSaving } from '../hooks/useSavingGuard.js';

// The session every app in this repo holds: one backend, one JWT, one set of
// localStorage keys. The keys are deliberately NOT prefixed with `appPrefix`,
// unlike everything else this package writes: plaid-igt and plaid-ud share the
// server's tokens, and the e2e helpers seed the same names for both.

// Get base URL from environment or use default
const BASE_URL = import.meta.env.VITE_API_URL || window.location.origin;

let client = null;
let limitsRequest = null;

// Where the app's sign-in page is, as a hash route. The app names it, the way
// it names `createProtectedRoute`'s `loginPath`: a routing table is an app's
// own, and a default here would be one app's table living in the package.
// No default, so a forgotten call is loud rather than a silent no-op.
let loginRoute = null;

/** Tell the session where sign-in is. Call once, at startup, from main.jsx. */
export const configureAuth = ({ loginRoute: route }) => {
  loginRoute = route;
};

const signInRoute = () => {
  if (!loginRoute) {
    throw new Error(
      'plaid-ui: no loginRoute. Call configureAuth({loginRoute}) from the app entry.',
    );
  }
  return loginRoute;
};

// JWT parsing utility
function parseJwtPayload(token) {
  try {
    // JWT tokens have 3 parts separated by dots: header.payload.signature
    const parts = token.split('.');
    if (parts.length !== 3) {
      throw new Error('Invalid JWT token format');
    }

    // Decode the payload (second part)
    const payload = parts[1];
    // Add padding if needed for base64 decoding
    const paddedPayload = payload + '='.repeat((4 - (payload.length % 4)) % 4);
    const decodedPayload = atob(paddedPayload);

    return JSON.parse(decodedPayload);
  } catch (error) {
    console.error('Failed to parse JWT payload:', error);
    return null;
  }
}

// Extract user ID from JWT token
function getUserIdFromToken(token) {
  const payload = parseJwtPayload(token);
  return payload?.['user/id'] || null; // Note: Clojure namespaced keyword becomes "user/id"
}

// ---- a sign-in that stops working ----------------------------------------
//
// Tokens do not expire, so a 401 means the token was revoked or the account
// deactivated. With nothing unsent it signs out as before. With a write
// refused, a draft typed, or a document still sending, the page stays: a
// notice offers sign-in in a new tab, and when that tab signs the same user
// in, every client this tab made takes the new token and carries on.

// Every client this session made, held weakly: an editor makes one per
// document it opens.
const sessionClients = new Set();
const track = (c) => {
  sessionClients.add(new WeakRef(c));
  return c;
};
const liveClients = () => {
  const out = [];
  for (const ref of sessionClients) {
    const c = ref.deref();
    if (c) out.push(c);
    else sessionClients.delete(ref);
  }
  return out;
};

// { user, toastId } while this tab's sign-in is lost, else null.
let signInLost = null;

const signInUrl = () =>
  `${window.location.origin}${window.location.pathname}${window.location.search}#${signInRoute().replace(/^#/, '')}`;

const onAuthError = (error) => {
  if (signInLost) return;
  const unsent =
    (error?.method && error.method !== 'GET') || !!hasUnsavedDraft() || anyDocumentSaving();
  if (!unsent) {
    authService.logout('expired');
    return;
  }
  const toastId = notifyWithAction('Your sign-in is no longer valid.', 'Signed out', {
    kind: 'error',
    duration: Infinity,
    label: 'Sign in',
    onClick: (event) => {
      // The notice stays until the new tab has signed in.
      event?.preventDefault?.();
      window.open(signInUrl(), '_blank', 'noopener');
    },
  });
  signInLost = { user: getUserIdFromToken(localStorage.getItem('token') || ''), toastId };
};

// Another tab signing the same user in hands this one its token.
const adoptToken = (token) => {
  if (!signInLost || !token || getUserIdFromToken(token) !== signInLost.user) return;
  for (const c of liveClients()) {
    c.token = token;
    c._authErrorFired = false;
  }
  toast.dismiss(signInLost.toastId);
  signInLost = null;
  notifySuccess('Signed in');
};
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === 'token') adoptToken(e.newValue);
  });
}

// Persist a freshly-authenticated client as the current session. Shared by
// login and invite redemption, which differ only in how they obtained the
// token. Everything after that (identify the user, fetch their profile, write
// localStorage) has to be identical, or a redeemed session ends up subtly
// unlike a logged-in one.
async function establishSession(authedClient) {
  client = authedClient;
  const token = client.token;

  const userId = getUserIdFromToken(token);
  if (!userId) {
    throw new Error('Could not extract user ID from token');
  }

  const userProfile = await client.users.get(userId);

  localStorage.setItem('token', token);
  localStorage.setItem('userId', userId);
  localStorage.setItem('displayName', userProfile.displayName);
  // Note: PlaidClient transforms is-admin to isAdmin
  localStorage.setItem('isAdmin', (userProfile.isAdmin || false).toString());
  // The profile picture's content hash, cached alongside the rest of the
  // session so the header avatar renders on first paint instead of after a
  // round-trip. Empty string means "no picture", which is a real state and has
  // to survive a reload as distinctly as a hash does.
  localStorage.setItem('avatarHash', userProfile.avatarHash || '');

  return {
    success: true,
    user: {
      id: userId,
      displayName: userProfile.displayName,
      isAdmin: userProfile.isAdmin || false,
      avatarHash: userProfile.avatarHash || null,
    },
  };
}

export const authService = {
  async login(email, password) {
    try {
      // Use PlaidClient's static login method
      return await establishSession(
        track(await PlaidClient.login(BASE_URL, email, password, { onAuthError })),
      );
    } catch (error) {
      console.error('Login failed:', error);
      throw error;
    }
  },

  // The limits the server enforces, read once. Unauthenticated, since the
  // invite page needs the password minimum before anyone has a session. A
  // failed read is not kept, so the next caller asks again.
  serverLimits() {
    if (!limitsRequest) {
      limitsRequest = PlaidClient.info(BASE_URL)
        .then((info) => info?.limits ?? null)
        .catch((err) => {
          limitsRequest = null;
          throw err;
        });
    }
    return limitsRequest;
  },

  // Describe an invite code. Deliberately NOT authenticated: whoever follows
  // an invite link has no account yet, which is the entire point.
  async lookupInvite(code) {
    return PlaidClient.lookupInvite(BASE_URL, code);
  },

  // Redeem an invite and land logged in. The redeemer just chose these
  // credentials, so sending them to the login form to retype them would be a
  // pointless place to lose someone.
  async redeemInvite(code, { email, password, displayName }) {
    const { client: authed } = await PlaidClient.redeemInvite(
      BASE_URL,
      code,
      { email, password, displayName },
      { onAuthError },
    );
    return establishSession(track(authed));
  },

  logout(reason = null) {
    client = null;
    // Tell the login page why it is being shown (read once, then cleared).
    try {
      if (reason) sessionStorage.setItem('plaid:logout-reason', reason);
    } catch {
      /* storage unavailable */
    }
    localStorage.removeItem('token');
    localStorage.removeItem('userId');
    localStorage.removeItem('displayName');
    localStorage.removeItem('isAdmin');
    localStorage.removeItem('avatarHash');
    // HashRouter plus a production base ('/igt/', '/ud/') mean sign-in lives in
    // the URL fragment. Navigating to an absolute path misses the SPA, since
    // the server has nothing there under the app's base. Set the fragment off
    // the current path so the base is preserved in both dev ('/') and prod,
    // then hard-reload to clear in-memory React state: the onAuthError path
    // calls logout() outside the AuthContext, so the user state will not reset
    // itself.
    window.location.hash = signInRoute();
    window.location.reload();
  },

  getCurrentUser() {
    const displayName = localStorage.getItem('displayName');
    const userId = localStorage.getItem('userId');
    const token = localStorage.getItem('token');
    const isAdmin = localStorage.getItem('isAdmin') === 'true';

    if (!displayName || !userId || !token) return null;

    return {
      // `id` IS the email address the user logs in with; `displayName` is the
      // mutable label shown in the UI.
      id: userId,
      displayName,
      isAdmin: isAdmin,
      avatarHash: localStorage.getItem('avatarHash') || null,
    };
  },

  getToken() {
    return localStorage.getItem('token');
  },

  isAuthenticated() {
    return !!this.getToken();
  },

  getClient() {
    const token = localStorage.getItem('token');
    if (!client && token) {
      // Recreate client from stored token
      client = authService.newClient(token);
    }
    return client;
  },

  // A client of its own on the session's token, for a screen that needs one
  // (an editor's strict-mode client). It answers a 401 as every other does.
  newClient(token = localStorage.getItem('token')) {
    return track(new PlaidClient(BASE_URL, token, { onAuthError }));
  },
};
