import PlaidClient from '@larc-iu/plaid-client';

const BASE_URL = import.meta.env.VITE_API_URL || window.location.origin;

let client = null;

function parseJwtPayload(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) throw new Error('Invalid JWT token format');
    const payload = parts[1];
    const padded = payload + '='.repeat((4 - (payload.length % 4)) % 4);
    return JSON.parse(atob(padded));
  } catch (error) {
    console.error('Failed to parse JWT payload:', error);
    return null;
  }
}

// Clojure's namespaced keyword arrives as the string "user/id".
const getUserIdFromToken = (token) => parseJwtPayload(token)?.['user/id'] || null;

// The session keys are the same ones plaid-igt writes. Served from the uberjar
// both apps share an origin, so a reader who is signed in to /igt/ is already
// signed in here.
async function establishSession(authedClient) {
  client = authedClient;
  const token = client.token;
  const userId = getUserIdFromToken(token);
  if (!userId) throw new Error('Could not extract user ID from token');

  const userProfile = await client.users.get(userId);
  localStorage.setItem('token', token);
  localStorage.setItem('userId', userId);
  localStorage.setItem('displayName', userProfile.displayName);
  localStorage.setItem('isAdmin', (userProfile.isAdmin || false).toString());

  return {
    user: {
      id: userId,
      displayName: userProfile.displayName,
      isAdmin: userProfile.isAdmin || false,
    },
  };
}

export const authService = {
  async login(email, password) {
    return establishSession(
      await PlaidClient.login(BASE_URL, email, password, {
        onAuthError: () => authService.logout('expired'),
      }),
    );
  },

  logout(reason = null) {
    client = null;
    try {
      if (reason) sessionStorage.setItem('plaid:logout-reason', reason);
    } catch {
      /* storage unavailable */
    }
    localStorage.removeItem('token');
    localStorage.removeItem('userId');
    localStorage.removeItem('displayName');
    localStorage.removeItem('isAdmin');
    // HashRouter plus the production '/dict/' base put the login route in the
    // fragment; an absolute '/login' would miss the SPA. Reload afterwards so
    // in-memory React state clears — onAuthError calls this from outside the
    // context, where the user state cannot reset itself.
    window.location.hash = '#/login';
    window.location.reload();
  },

  getCurrentUser() {
    const displayName = localStorage.getItem('displayName');
    const userId = localStorage.getItem('userId');
    const token = localStorage.getItem('token');
    if (!displayName || !userId || !token) return null;
    return {
      // `id` IS the email address; `displayName` is the label shown on screen.
      id: userId,
      displayName,
      isAdmin: localStorage.getItem('isAdmin') === 'true',
    };
  },

  getClient() {
    const token = localStorage.getItem('token');
    if (!client && token) {
      client = new PlaidClient(BASE_URL, token, {
        onAuthError: () => authService.logout('expired'),
      });
    }
    return client;
  },
};
