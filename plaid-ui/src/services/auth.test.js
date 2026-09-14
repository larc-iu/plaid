import { describe, it, expect, beforeEach, vi } from 'vitest';

// A JWT is three dot-separated base64url parts and this module reads only the
// middle one, so a hand-built payload is enough.
const tokenFor = (userId) => `h.${btoa(JSON.stringify({ 'user/id': userId }))}.s`;

const PROFILE = { displayName: 'Ada', isAdmin: true, avatarHash: 'abc123' };

const clientFor = (userId) => ({
  token: tokenFor(userId),
  users: { get: vi.fn(async () => PROFILE) },
});

const login = vi.fn();
const lookupInvite = vi.fn();
const redeemInvite = vi.fn();

vi.mock('@larc-iu/plaid-client', () => {
  class PlaidClient {
    constructor(baseUrl, token, options) {
      this.baseUrl = baseUrl;
      this.token = token;
      this.options = options;
    }
    static login = (...args) => login(...args);
    static lookupInvite = (...args) => lookupInvite(...args);
    static redeemInvite = (...args) => redeemInvite(...args);
  }
  return { default: PlaidClient };
});

const { authService } = await import('./auth.js');

const session = () => ({
  token: localStorage.getItem('token'),
  userId: localStorage.getItem('userId'),
  displayName: localStorage.getItem('displayName'),
  isAdmin: localStorage.getItem('isAdmin'),
  avatarHash: localStorage.getItem('avatarHash'),
});

describe('authService', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.clearAllMocks();
  });

  it('writes the whole session on login', async () => {
    login.mockResolvedValue(clientFor('ada@example.com'));

    const result = await authService.login('ada@example.com', 'pw');

    expect(result).toEqual({
      success: true,
      user: {
        id: 'ada@example.com',
        displayName: 'Ada',
        isAdmin: true,
        avatarHash: 'abc123',
      },
    });
    expect(session()).toEqual({
      token: tokenFor('ada@example.com'),
      userId: 'ada@example.com',
      displayName: 'Ada',
      isAdmin: 'true',
      avatarHash: 'abc123',
    });
  });

  // The comment on establishSession promises this: a redeemed session must be
  // indistinguishable from a logged-in one.
  it('leaves a redeemed invite in the same state as a login', async () => {
    login.mockResolvedValue(clientFor('ada@example.com'));
    await authService.login('ada@example.com', 'pw');
    const afterLogin = session();

    localStorage.clear();
    redeemInvite.mockResolvedValue({ client: clientFor('ada@example.com') });
    const result = await authService.redeemInvite('CODE', {
      email: 'ada@example.com',
      password: 'pw',
      displayName: 'Ada',
    });

    expect(result.user.id).toBe('ada@example.com');
    expect(session()).toEqual(afterLogin);
  });

  it('reads back a stored session, and nothing without a token', () => {
    expect(authService.getCurrentUser()).toBe(null);
    expect(authService.isAuthenticated()).toBe(false);

    localStorage.setItem('token', tokenFor('ada@example.com'));
    localStorage.setItem('userId', 'ada@example.com');
    localStorage.setItem('displayName', 'Ada');
    localStorage.setItem('isAdmin', 'false');

    expect(authService.getCurrentUser()).toEqual({
      id: 'ada@example.com',
      displayName: 'Ada',
      isAdmin: false,
      avatarHash: null,
    });
    expect(authService.isAuthenticated()).toBe(true);
  });

  it('clears every session key on logout and records the reason', () => {
    localStorage.setItem('token', tokenFor('ada@example.com'));
    localStorage.setItem('userId', 'ada@example.com');
    localStorage.setItem('displayName', 'Ada');
    localStorage.setItem('isAdmin', 'true');
    localStorage.setItem('avatarHash', 'abc123');
    vi.spyOn(window.location, 'reload').mockImplementation(() => {});

    authService.logout('expired');

    expect(session()).toEqual({
      token: null,
      userId: null,
      displayName: null,
      isAdmin: null,
      avatarHash: null,
    });
    expect(sessionStorage.getItem('plaid:logout-reason')).toBe('expired');
    expect(window.location.hash).toBe('#/login');
  });

  it('rebuilds a client from a stored token, and none without one', () => {
    expect(authService.getClient()).toBe(null);

    localStorage.setItem('token', tokenFor('ada@example.com'));
    const client = authService.getClient();
    expect(client.token).toBe(tokenFor('ada@example.com'));
  });

  it('looks an invite up without authenticating', async () => {
    lookupInvite.mockResolvedValue({ email: 'ada@example.com' });
    await authService.lookupInvite('CODE');
    expect(lookupInvite).toHaveBeenCalledWith(expect.any(String), 'CODE');
  });
});
