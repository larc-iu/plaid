import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent, byText } from '../../test/renderComponent.jsx';

// The API-token failure is what a person reads, so whatever reaches the toast is
// what they get. A client error's message carries the request URL and the ids it
// was given, and `humanizeError` is the one place that becomes a sentence:
// concatenating `err.message` walked straight past it. (Carried over from
// plaid-ud, where this screen used to live in two copies.)

const { toast, auth, confirm } = vi.hoisted(() => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
  auth: {
    user: { id: 'ada@example.com', displayName: 'Ada' },
    client: null,
    updateUser: vi.fn(),
  },
  confirm: vi.fn(async () => false),
}));

vi.mock('sonner', () => ({ toast }));
vi.mock('../shared/ConfirmProvider', () => ({ useConfirm: () => confirm }));
vi.mock('../../contexts/useAuth.js', () => ({ useAuth: () => auth }));

const { UserProfile } = await import('./UserProfile.jsx');

const baseClient = (over = {}) => ({
  users: { avatarUrl: () => null },
  apiTokens: { list: async () => [], ...over },
});

const mount = () => renderComponent(<MemoryRouter>{<UserProfile />}</MemoryRouter>);

const typeInto = (input, text) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(input, text);
  input.dispatchEvent(new Event('input', { bubbles: true }));
};

const submitAround = async (view, input) =>
  view.step(async () => {
    input.closest('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 0));
  });

beforeEach(() => {
  vi.clearAllMocks();
  confirm.mockResolvedValue(false);
  auth.client = baseClient();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the API token failures', () => {
  it('says what a stalled server means rather than quoting the request', async () => {
    auth.client = baseClient({
      create: async () => {
        throw Object.assign(
          new Error(
            'HTTP 503 Service Unavailable at http://localhost:8085/api/v1/users/ada@example.com/tokens',
          ),
          { status: 503 },
        );
      },
    });
    const view = await mount();

    const name = view.container.querySelector('#token-name');
    await view.step(() => typeInto(name, 'Stanza'));
    await submitAround(view, name);

    expect(toast.error).toHaveBeenCalledWith('Could not create the token', {
      description: 'Could not reach the server. Check your connection and try again.',
    });
    expect(JSON.stringify(toast.error.mock.calls)).not.toContain('http');
    await view.unmount();
  });

  it('refuses a nameless token without asking the server', async () => {
    const create = vi.fn();
    auth.client = baseClient({ create });
    const view = await mount();

    await submitAround(view, view.container.querySelector('#token-name'));

    expect(create).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith('Could not create the token', {
      description: 'Name the token',
    });
    await view.unmount();
  });
});

describe('revoking a token', () => {
  const listed = [{ id: 't1', name: 'Stanza Parser', createdAt: '2026-09-01T00:00:00Z' }];

  it('names the token in the confirm, and does nothing when it is declined', async () => {
    const revoke = vi.fn();
    auth.client = baseClient({ list: async () => listed, revoke });
    const view = await mount();

    await view.step(async () => {
      byText(view.container, 'button', 'Revoke').click();
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        description: expect.stringContaining('Stanza Parser'),
        destructive: true,
      }),
    );
    expect(revoke).not.toHaveBeenCalled();
    await view.unmount();
  });

  it('revokes once the confirm is taken', async () => {
    const revoke = vi.fn(async () => {});
    auth.client = baseClient({ list: async () => listed, revoke });
    confirm.mockResolvedValue(true);
    const view = await mount();

    await view.step(async () => {
      byText(view.container, 'button', 'Revoke').click();
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(revoke).toHaveBeenCalledWith('ada@example.com', 't1');
    await view.unmount();
  });

  it('shows only the tokens that are still live', async () => {
    auth.client = baseClient({
      list: async () => [
        ...listed,
        { id: 't2', name: 'Retired', revokedAt: '2026-09-02T00:00:00Z' },
      ],
    });
    const view = await mount();

    expect(view.container.textContent).toContain('Stanza Parser');
    expect(view.container.textContent).not.toContain('Retired');
    await view.unmount();
  });
});

describe('the profile form', () => {
  const openEditor = async (view) =>
    view.step(async () => {
      byText(view.container, 'button', 'Edit profile').click();
    });

  it('refuses a new password with no current one, per field', async () => {
    const update = vi.fn();
    auth.client = { ...baseClient(), users: { avatarUrl: () => null, update } };
    const view = await mount();
    await openEditor(view);

    await view.step(() => typeInto(view.container.querySelector('#newPassword'), 'longenough'));
    await submitAround(view, view.container.querySelector('#newPassword'));

    expect(view.container.textContent).toContain('Current password is required to change password');
    expect(update).not.toHaveBeenCalled();
    await view.unmount();
  });

  it('says so rather than writing when nothing changed', async () => {
    const update = vi.fn();
    auth.client = { ...baseClient(), users: { avatarUrl: () => null, update } };
    const view = await mount();
    await openEditor(view);

    await submitAround(view, view.container.querySelector('#displayName'));

    expect(update).not.toHaveBeenCalled();
    expect(toast.warning).toHaveBeenCalled();
    await view.unmount();
  });
});
