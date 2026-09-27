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

const notify = vi.hoisted(() => ({ withAction: vi.fn(() => 'toast-1'), success: vi.fn() }));
vi.mock('../lib/notify.js', () => ({
  notifyWithAction: notify.withAction,
  notifySuccess: notify.success,
}));
const dismiss = vi.hoisted(() => vi.fn());
vi.mock('sonner', () => ({ toast: { dismiss } }));
const unsaved = vi.hoisted(() => ({ draft: null }));
vi.mock('../hooks/useUnsavedDraft.js', () => ({ hasUnsavedDraft: () => unsaved.draft }));

const { authService, configureAuth, onSignOut } = await import('./auth.js');
configureAuth({ loginRoute: '#/login' });

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

  it('refuses to sign out to a route no app named', () => {
    configureAuth({ loginRoute: null });
    expect(() => authService.logout()).toThrow(/loginRoute/);
    configureAuth({ loginRoute: '#/login' });
  });

  // What an app keeps in the browser for this login goes before the page
  // reloads: the reload would cut an unfinished IndexedDB write short.
  it('lets go of what an app keeps for the login before leaving the page', async () => {
    localStorage.setItem('token', tokenFor('ada@example.com'));
    window.location.hash = '#/projects/p1';
    const reload = vi.spyOn(window.location, 'reload').mockImplementation(() => {});
    let done;
    const hook = vi.fn(() => new Promise((resolve) => (done = resolve)));
    const off = onSignOut(hook);
    try {
      authService.logout();
      expect(hook).toHaveBeenCalledTimes(1);
      expect(localStorage.getItem('token')).toBe(null);
      await Promise.resolve();
      expect(window.location.hash).toBe('#/projects/p1');
      expect(reload).not.toHaveBeenCalled();
      done();
      await vi.waitFor(() => expect(reload).toHaveBeenCalled());
      expect(window.location.hash).toBe('#/login');
    } finally {
      off();
    }
  });

  it('leaves the page anyway when a hook fails or never answers', async () => {
    vi.useFakeTimers();
    const reload = vi.spyOn(window.location, 'reload').mockImplementation(() => {});
    const offs = [
      onSignOut(() => {
        throw new Error('boom');
      }),
      onSignOut(() => new Promise(() => {})),
    ];
    try {
      authService.logout();
      expect(reload).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(5000);
      expect(reload).toHaveBeenCalledTimes(1);
      expect(window.location.hash).toBe('#/login');
    } finally {
      offs.forEach((off) => off());
      vi.useRealTimers();
    }
  });

  it('runs no hook once it is taken back', () => {
    vi.spyOn(window.location, 'reload').mockImplementation(() => {});
    const hook = vi.fn();
    onSignOut(hook)();
    authService.logout();
    expect(hook).not.toHaveBeenCalled();
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

// A 401 is an expired or revoked token, or a deactivated account.
// With something unsent the page stays and says so, and a sign-in in another
// tab hands this one its token. Without, it signs out as it always did.
describe('a 401', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.clearAllMocks();
    window.location.hash = '#/projects/p1';
    vi.spyOn(window.location, 'reload').mockImplementation(() => {});
  });
  const signedIn = (userId = 'ada@example.com') => {
    localStorage.setItem('token', tokenFor(userId));
    localStorage.setItem('userId', userId);
    localStorage.setItem('displayName', 'Ada');
    return authService.newClient();
  };
  const refuse = (c, method) =>
    c.options.onAuthError(Object.assign(new Error('HTTP 401'), { status: 401, method }));
  const otherTabSignsIn = (token) =>
    window.dispatchEvent(new StorageEvent('storage', { key: 'token', newValue: token }));

  it('on a read with nothing unsent signs out to the sign-in page', () => {
    const c = signedIn();
    refuse(c, 'GET');
    expect(window.location.hash).toBe('#/login');
    expect(localStorage.getItem('token')).toBe(null);
    expect(notify.withAction).not.toHaveBeenCalled();
  });

  it('on a write keeps the page, and a sign-in in another tab carries on with its token', () => {
    const c = signedIn();
    const other = authService.newClient();
    c._authErrorFired = true;
    refuse(c, 'PATCH');
    expect(window.location.hash).toBe('#/projects/p1');
    expect(localStorage.getItem('token')).toBe(tokenFor('ada@example.com'));
    expect(notify.withAction).toHaveBeenCalledTimes(1);
    expect(notify.withAction.mock.calls[0][0]).toBe('Your sign-in is no longer valid.');
    // A second refusal says nothing more.
    refuse(other, 'PATCH');
    expect(notify.withAction).toHaveBeenCalledTimes(1);

    // Another user signing in elsewhere is not this tab's sign-in.
    otherTabSignsIn(tokenFor('bob@example.com'));
    expect(c.token).toBe(tokenFor('ada@example.com'));
    expect(dismiss).not.toHaveBeenCalled();

    const fresh = `${tokenFor('ada@example.com')}2`;
    otherTabSignsIn(fresh);
    expect(c.token).toBe(fresh);
    expect(other.token).toBe(fresh);
    expect(c._authErrorFired).toBe(false);
    expect(dismiss).toHaveBeenCalledWith('toast-1');
  });

  // localStorage is shared by every tab of the origin, so once another tab
  // signs someone else in it holds THEIR token. This tab is still its own user.
  const anotherTabSignsInAs = (userId) => {
    localStorage.setItem('token', tokenFor(userId));
    localStorage.setItem('userId', userId);
  };
  const freshSession = (userId) => {
    authService.logout();
    window.location.hash = '#/projects/p1';
    localStorage.setItem('token', tokenFor(userId));
    localStorage.setItem('userId', userId);
    return authService.getClient();
  };

  it("makes a new client on this tab's token after another tab signs someone else in", () => {
    freshSession('ada@example.com');
    anotherTabSignsInAs('bob@example.com');
    expect(authService.newClient().token).toBe(tokenFor('ada@example.com'));
  });

  it("waits for this tab's user, not whoever another tab signed in before the 401", () => {
    const c = freshSession('ada@example.com');
    anotherTabSignsInAs('bob@example.com');
    refuse(c, 'PATCH');
    expect(notify.withAction).toHaveBeenCalledTimes(1);
    otherTabSignsIn(`${tokenFor('bob@example.com')}4`);
    expect(c.token).toBe(tokenFor('ada@example.com'));
    expect(dismiss).not.toHaveBeenCalled();
    // Ada signing in again elsewhere is what this tab waits for.
    otherTabSignsIn(`${tokenFor('ada@example.com')}4`);
    expect(c.token).toBe(`${tokenFor('ada@example.com')}4`);
  });

  it('on a read keeps the page while something typed is unsaved', () => {
    const c = signedIn();
    unsaved.draft = 'The gloss you have typed';
    try {
      refuse(c, 'GET');
    } finally {
      unsaved.draft = null;
    }
    expect(window.location.hash).toBe('#/projects/p1');
    expect(notify.withAction).toHaveBeenCalledTimes(1);
    otherTabSignsIn(`${tokenFor('ada@example.com')}3`);
    expect(c.token).toBe(`${tokenFor('ada@example.com')}3`);
  });
});
