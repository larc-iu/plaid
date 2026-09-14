import { useEffect } from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderComponent } from '../test/renderComponent.jsx';
import { AuthProvider } from './AuthContext.jsx';
import { useAuth } from './useAuth.js';

const { CLIENT, authService } = vi.hoisted(() => {
  const CLIENT = { name: 'the client' };
  return {
    CLIENT,
    authService: {
      getCurrentUser: vi.fn(() => null),
      getClient: vi.fn(() => CLIENT),
      login: vi.fn(),
      redeemInvite: vi.fn(),
      logout: vi.fn(),
    },
  };
});

vi.mock('../services/auth.js', () => ({ authService }));

let seen = null;
// Published from an effect rather than from the render body: a render that
// writes to the world outside it is the thing the lint rules are there to stop.
const Probe = () => {
  const auth = useAuth();
  useEffect(() => {
    seen = auth;
  });
  return null;
};

const mount = () =>
  renderComponent(
    <AuthProvider>
      <Probe />
    </AuthProvider>,
  );

describe('AuthProvider', () => {
  beforeEach(() => {
    seen = null;
    vi.clearAllMocks();
    authService.getCurrentUser.mockReturnValue(null);
    authService.getClient.mockReturnValue(CLIENT);
  });

  it('has no client while signed out, and refuses to invent one', async () => {
    await mount();
    expect(seen.isAuthenticated).toBe(false);
    expect(seen.client).toBe(null);
    expect(() => seen.getClient()).toThrow('Not authenticated');
  });

  it('answers both ways once signed in', async () => {
    authService.getCurrentUser.mockReturnValue({ id: 'ada@example.com', displayName: 'Ada' });
    await mount();
    expect(seen.isAuthenticated).toBe(true);
    expect(seen.client).toBe(CLIENT);
    expect(seen.getClient()).toBe(CLIENT);
  });

  it('picks the client up on login and drops it on logout', async () => {
    authService.login.mockResolvedValue({ user: { id: 'ada@example.com', displayName: 'Ada' } });
    const { step } = await mount();
    expect(seen.client).toBe(null);

    await step(() => seen.login('ada@example.com', 'pw'));
    expect(seen.client).toBe(CLIENT);

    await step(() => seen.logout('expired'));
    expect(authService.logout).toHaveBeenCalledWith('expired');
    expect(seen.client).toBe(null);
    expect(() => seen.getClient()).toThrow('Not authenticated');
  });

  it('reports a failed sign-in rather than throwing', async () => {
    authService.login.mockRejectedValue(Object.assign(new Error('nope'), { status: 401 }));
    const { step } = await mount();

    let result;
    await step(async () => {
      result = await seen.login('ada@example.com', 'wrong');
    });
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
    expect(seen.isAuthenticated).toBe(false);
  });

  it('names the invite link in a 404 from redemption', async () => {
    authService.redeemInvite.mockRejectedValue(Object.assign(new Error('gone'), { status: 404 }));
    const { step } = await mount();

    let result;
    await step(async () => {
      result = await seen.redeemInvite('CODE', { email: 'a@b.com', password: 'pw' });
    });
    expect(result).toMatchObject({ success: false, error: 'This invitation link is not valid.' });
  });
});
