import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderComponent } from '@ui/test/renderComponent.jsx';
import { type } from '../../test/keyboard.js';

// The API-token banner is rendered verbatim, so whatever reaches it is what a
// person reads. A client error's message carries the request URL and the ids
// it was given, and `humanizeError` is the one place that becomes a sentence:
// concatenating `err.message` walked straight past it.

const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn(), warning: vi.fn() }));
vi.mock('sonner', () => ({ toast }));
vi.mock('@ui/components/shared/ConfirmProvider', () => ({ useConfirm: () => async () => false }));

const auth = vi.hoisted(() => ({
  user: { id: 'ada@example.com', displayName: 'Ada' },
  getClient: vi.fn(),
  updateUser: vi.fn(),
}));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => auth }));

const { UserProfile } = await import('./UserProfile.jsx');

const clientThatRefuses = (err) => ({
  apiTokens: {
    list: async () => [],
    create: async () => {
      throw err;
    },
  },
  users: { avatarUrl: () => null },
});

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

const banner = (container) => container.querySelector('[role="alert"]')?.textContent ?? '';

describe('the API token banner', () => {
  it('says what a stalled server means rather than quoting the request', async () => {
    auth.getClient.mockReturnValue(
      clientThatRefuses(
        Object.assign(
          new Error(
            'HTTP 503 Service Unavailable at http://localhost:8085/api/v1/users/ada@example.com/tokens',
          ),
          { status: 503 },
        ),
      ),
    );
    const view = await renderComponent(<UserProfile />);

    const name = view.container.querySelector('#token-name');
    await view.step(() => type(name, 'Stanza'));
    await view.step(async () => {
      name.closest('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(banner(view.container)).toBe(
      'Failed to create API token: Could not reach the server. Check your connection and try again.',
    );
    expect(banner(view.container)).not.toContain('http');
    await view.unmount();
  });
});
