import PlaidClient from '@larc-iu/plaid-client';

// Get base URL from environment or use default
const BASE_URL = import.meta.env.VITE_API_URL || window.location.origin;

let client = null;

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

// Persist a freshly-authenticated client as the current session. Shared by
// login and invite redemption, which differ only in how they obtained the
// token — everything after that (identify the user, fetch their profile, write
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
  localStorage.setItem('username', userProfile.username);
  // Note: PlaidClient transforms is-admin to isAdmin
  localStorage.setItem('isAdmin', (userProfile.isAdmin || false).toString());

  return {
    success: true,
    user: {
      id: userId,
      username: userProfile.username,
      isAdmin: userProfile.isAdmin || false,
    },
  };
}

export const authService = {
  async login(username, password) {
    try {
      // Use PlaidClient's static login method
      return await establishSession(
        await PlaidClient.login(BASE_URL, username, password, {
          onAuthError: () => authService.logout(),
        }),
      );
    } catch (error) {
      console.error('Login failed:', error);
      throw error;
    }
  },

  // Describe an invite code. Deliberately NOT authenticated: whoever follows
  // an invite link has no account yet, which is the entire point.
  async lookupInvite(code) {
    return PlaidClient.lookupInvite(BASE_URL, code);
  },

  // Redeem an invite and land logged in. The redeemer just chose these
  // credentials, so sending them to the login form to retype them would be a
  // pointless place to lose someone.
  async redeemInvite(code, { username, password }) {
    const { client: authed } = await PlaidClient.redeemInvite(
      BASE_URL,
      code,
      { username, password },
      { onAuthError: () => authService.logout() },
    );
    return establishSession(authed);
  },

  logout() {
    client = null;
    localStorage.removeItem('token');
    localStorage.removeItem('userId');
    localStorage.removeItem('username');
    localStorage.removeItem('isAdmin');
    // HashRouter + the production '/igt/' base mean the login route lives in the
    // URL fragment; navigating to an absolute '/login' path misses the SPA (the
    // server has nothing there under /igt/). Set the fragment off the current
    // path so the base is preserved in both dev ('/') and prod ('/igt/'), then
    // hard-reload to clear in-memory React state — the onAuthError path calls
    // logout() outside the AuthContext, so the user state won't reset itself.
    window.location.hash = '#/login';
    window.location.reload();
  },

  getCurrentUser() {
    const username = localStorage.getItem('username');
    const userId = localStorage.getItem('userId');
    const token = localStorage.getItem('token');
    const isAdmin = localStorage.getItem('isAdmin') === 'true';

    if (!username || !userId || !token) return null;

    return {
      id: userId,
      username: username,
      isAdmin: isAdmin,
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
      client = new PlaidClient(BASE_URL, token, {
        onAuthError: () => authService.logout(),
      });
    }
    return client;
  },
};
