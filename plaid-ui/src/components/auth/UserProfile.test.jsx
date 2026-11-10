import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { configureUi } from '../../lib/uiConfig.js';
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
    logout: vi.fn(),
  },
  confirm: vi.fn(async () => false),
}));

vi.mock('sonner', () => ({ toast }));
vi.mock('../shared/ConfirmProvider', () => ({ useConfirm: () => confirm }));
vi.mock('../../contexts/useAuth.js', () => ({ useAuth: () => auth }));
vi.mock('../../services/auth.js', () => ({
  authService: { serverLimits: async () => ({ passwordMinLength: 12 }) },
}));

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

    expect(toast.error).toHaveBeenCalledWith('Failed to create the token', {
      description: 'Failed to reach the server. Check your connection and try again.',
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
    expect(toast.error).toHaveBeenCalledWith('Failed to create the token', {
      description: 'Name the token',
    });
    await view.unmount();
  });
});

describe('revoking a token', () => {
  const listed = [{ id: 't1', name: 'Stanza parser', createdAt: '2026-09-01T00:00:00Z' }];

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
        title: 'Revoke “Stanza parser”?',
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

    expect(view.container.textContent).toContain('Stanza parser');
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

  it('asks the password minimum the server publishes', async () => {
    const update = vi.fn();
    auth.client = { ...baseClient(), users: { avatarUrl: () => null, update } };
    const view = await mount();
    await openEditor(view);

    await view.step(() => {
      typeInto(view.container.querySelector('#currentPassword'), 'the-old-one');
      typeInto(view.container.querySelector('#newPassword'), 'elevenchars');
      typeInto(view.container.querySelector('#confirmPassword'), 'elevenchars');
    });
    await submitAround(view, view.container.querySelector('#newPassword'));

    expect(view.container.textContent).toContain('Password must be at least 12 characters');
    expect(update).not.toHaveBeenCalled();
    await view.unmount();
  });

  const fillPasswords = (view, current) =>
    view.step(() => {
      typeInto(view.container.querySelector('#currentPassword'), current);
      typeInto(view.container.querySelector('#newPassword'), 'a-new-password');
      typeInto(view.container.querySelector('#confirmPassword'), 'a-new-password');
    });

  it('sends the current password with a new one', async () => {
    const update = vi.fn(async () => ({}));
    auth.client = { ...baseClient(), users: { avatarUrl: () => null, update, get: vi.fn() } };
    const view = await mount();
    await openEditor(view);
    await fillPasswords(view, 'the-old-one');
    await submitAround(view, view.container.querySelector('#newPassword'));

    expect(update).toHaveBeenCalledWith(
      'ada@example.com',
      'a-new-password',
      undefined,
      undefined,
      undefined,
      { currentPassword: 'the-old-one' },
    );
    await view.unmount();
  });

  // H1-2: the change ends this session too, and reading the user back with the
  // dead token signed out with "Your session has expired".
  it('signs out saying the password changed, without reading the user back', async () => {
    const get = vi.fn();
    const update = vi.fn(async () => ({}));
    auth.client = { ...baseClient(), users: { avatarUrl: () => null, update, get } };
    const view = await mount();
    await openEditor(view);
    await fillPasswords(view, 'the-old-one');
    await submitAround(view, view.container.querySelector('#newPassword'));

    expect(auth.logout).toHaveBeenCalledWith('password-changed');
    expect(get).not.toHaveBeenCalled();
    await view.unmount();
  });

  it('keeps the session for a display name change', async () => {
    const get = vi.fn(async () => ({ id: 'ada@example.com', displayName: 'Ada L' }));
    const update = vi.fn(async () => ({}));
    auth.client = { ...baseClient(), users: { avatarUrl: () => null, update, get } };
    const view = await mount();
    await openEditor(view);
    await view.step(() => typeInto(view.container.querySelector('#displayName'), 'Ada L'));
    await submitAround(view, view.container.querySelector('#displayName'));

    expect(auth.logout).not.toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalled();
    await view.unmount();
  });

  it('shows a refused current password on its field', async () => {
    const update = vi.fn(async () => {
      throw Object.assign(new Error('HTTP 403'), {
        status: 403,
        responseData: { error: 'Current password is incorrect' },
      });
    });
    auth.client = { ...baseClient(), users: { avatarUrl: () => null, update } };
    const view = await mount();
    await openEditor(view);
    await fillPasswords(view, 'not-it');
    await submitAround(view, view.container.querySelector('#newPassword'));

    const field = view.container.querySelector('#currentPassword').parentElement;
    expect(field.textContent).toContain('Current password is incorrect');
    expect(toast.error).not.toHaveBeenCalled();
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

// H1 S5: Back was the browser's, so on a profile opened from a bookmark it
// left the app.
describe('Back', () => {
  const at = (entries) => {
    let path = null;
    const Probe = () => {
      path = useLocation().pathname;
      return null;
    };
    return renderComponent(
      <MemoryRouter initialEntries={entries} initialIndex={entries.length - 1}>
        <Routes>
          <Route path="/profile" element={<UserProfile />} />
          <Route path="*" element={<p>elsewhere</p>} />
        </Routes>
        <Probe />
      </MemoryRouter>,
    ).then((view) => ({ view, path: () => path }));
  };
  const back = (view) => byText(view.container, 'button', 'Back');

  const RESTORE = { appPrefix: 'plaid_igt', configNamespace: 'igt', appName: 'Plaid IGT' };
  beforeEach(() => configureUi({ ...RESTORE, appRoutes: { projects: '/projects' } }));
  afterEach(() => configureUi(RESTORE));

  it('goes to the projects list on a profile opened first', async () => {
    const { view, path } = await at(['/profile']);
    await view.step(() => back(view).click());
    expect(path()).toBe('/projects');
    await view.unmount();
  });

  // REV-FX-B-1: sign-in reaches a bookmarked profile with a replace, which
  // gives the entry a key of its own while it is still the tab's first.
  it('goes to the projects list on a profile reached through sign-in', async () => {
    const before = window.history.state;
    window.history.replaceState({ idx: 0, key: 'k1' }, '');
    try {
      const { view, path } = await at([{ pathname: '/profile', key: 'k1' }]);
      await view.step(() => back(view).click());
      expect(path()).toBe('/projects');
      await view.unmount();
    } finally {
      window.history.replaceState(before, '');
    }
  });

  it('goes back to where the profile was opened from', async () => {
    const { view, path } = await at(['/projects/p1/documents', '/profile']);
    await view.step(() => back(view).click());
    expect(path()).toBe('/projects/p1/documents');
    await view.unmount();
  });
});
