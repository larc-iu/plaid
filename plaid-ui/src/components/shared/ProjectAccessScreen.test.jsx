import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent, byText } from '../../test/renderComponent.jsx';
import { projectRoleOptions } from '../../domain/projectRoles.js';

// The access screen's account administration, which is the half of it an admin
// can get wrong in a way nobody sees until someone cannot sign in.

const toast = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
  promise: vi.fn(),
}));
vi.mock('sonner', () => ({ toast }));
// The invite table and the directory search each fetch on mount; neither is
// what these tests are about.
vi.mock('./ProjectInvites.jsx', () => ({ ProjectInvites: () => null }));
vi.mock('./UserSearch.jsx', () => ({ UserSearch: () => null }));

const { ProjectAccessScreen } = await import('./ProjectAccessScreen.jsx');

const ROLE_OPTIONS = projectRoleOptions({
  readerHint: 'Reads it.',
  writerHint: 'Also writes it.',
});

const PROJECT = { id: 'p1', name: 'Ay', maintainers: ['u'], writers: [], readers: [] };
const USER = { id: 'u', displayName: 'You', isAdmin: true };

const fakeClient = (overrides = {}) => ({
  projects: { get: vi.fn().mockResolvedValue(PROJECT) },
  users: {
    get: vi.fn(async (id) => ({ id, displayName: id, isAdmin: false })),
    avatarUrl: () => null,
    create: vi.fn().mockResolvedValue({ id: 'grace@example.com' }),
    listPage: vi.fn().mockResolvedValue({ entries: [] }),
    ...overrides,
  },
});

const mount = (client) =>
  renderComponent(
    <MemoryRouter>
      <ProjectAccessScreen
        project={PROJECT}
        projectId="p1"
        client={client}
        user={USER}
        onDataUpdate={vi.fn()}
        roleOptions={ROLE_OPTIONS}
      />
    </MemoryRouter>,
  );

const field = (id) => document.body.querySelector(`#${id}`);

// Typing into a controlled input: React skips onChange when the DOM value is
// assigned directly, so it goes through the native setter first.
const typeInto = (el, value) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
};

const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true }));

const openCreate = async (view) => {
  await view.step(() => click(byText(view.container, 'button', 'Create user')));
};

const submit = async (view) => {
  await view.step(async () => {
    click(byText(document.body, 'button', 'Create User'));
    await new Promise((r) => setTimeout(r, 0));
  });
};

beforeEach(() => {
  toast.error.mockClear();
  toast.success.mockClear();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => vi.restoreAllMocks());

describe('creating an account from the access screen', () => {
  it('says what a refused create means rather than quoting the request', async () => {
    // The toast is what the admin reads, so a raw client message would put the
    // request URL and the ids it carried on screen.
    const client = fakeClient({
      create: vi
        .fn()
        .mockRejectedValue(
          Object.assign(
            new Error('HTTP 503 Service Unavailable at http://localhost:8085/api/v1/users'),
            { status: 503 },
          ),
        ),
    });
    const view = await mount(client);
    await openCreate(view);
    await view.step(() => typeInto(field('user-admin-email'), 'grace@example.com'));
    await view.step(() => typeInto(field('user-admin-password'), 'hopper1'));
    await view.step(() => typeInto(field('user-admin-password-confirm'), 'hopper1'));
    await submit(view);

    expect(client.users.create).toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith('Could not create the account', {
      description: 'Could not reach the server. Check your connection and try again.',
    });
    await view.unmount();
  });

  it('will not send a password that was typed differently twice', async () => {
    // Whoever types it is not the person who will use it: an admin cannot tell
    // a mistyped password from a correct one, and the account is unreachable
    // until somebody mints a reset link.
    const client = fakeClient();
    const view = await mount(client);
    await openCreate(view);
    await view.step(() => typeInto(field('user-admin-email'), 'grace@example.com'));
    await view.step(() => typeInto(field('user-admin-password'), 'hopper1'));
    await view.step(() => typeInto(field('user-admin-password-confirm'), 'hopper2'));
    await submit(view);

    expect(client.users.create).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith('Check the password', {
      description: 'The two passwords do not match',
    });
    await view.unmount();
  });
});
