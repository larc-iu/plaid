import { describe, it, expect, beforeEach, vi } from 'vitest';

// The Setup form is typed and then saved, so a 401 on that save must keep the
// page (and the typed form) the way the other apps do, rather than sign out.
const tokenFor = (userId) => `h.${btoa(JSON.stringify({ 'user/id': userId }))}.s`;

vi.mock('@larc-iu/plaid-client', () => {
  class PlaidClient {
    constructor(baseUrl, token, options) {
      this.token = token;
      this.options = options;
    }
  }
  return { default: PlaidClient };
});
vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), dismiss: vi.fn() }),
}));

const { authService } = await import('./auth.js');

describe('a 401 in plaid-dict', () => {
  beforeEach(() => {
    localStorage.clear();
    window.location.hash = '#/setup/v1';
    vi.spyOn(window.location, 'reload').mockImplementation(() => {});
    localStorage.setItem('token', tokenFor('ada@example.com'));
    localStorage.setItem('userId', 'ada@example.com');
    localStorage.setItem('displayName', 'Ada');
  });

  it('on a save keeps the page and what is typed on it', () => {
    const c = authService.getClient();
    c.options.onAuthError(Object.assign(new Error('HTTP 401'), { status: 401, method: 'PUT' }));
    expect(window.location.hash).toBe('#/setup/v1');
    expect(localStorage.getItem('token')).toBe(tokenFor('ada@example.com'));
  });
});
