import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../lib/notify.js', () => ({ notifySuccess: vi.fn(), notifyError: vi.fn() }));
const limits = vi.hoisted(() => ({ passwordMinLength: 8 }));
vi.mock('../services/auth.js', () => ({ authService: { serverLimits: async () => limits } }));

const { notifyError } = await import('../lib/notify.js');
const { renderComponent } = await import('../test/renderComponent.jsx');
const { useUserAdmin } = await import('./useUserAdmin.js');

// The password minimum is checked here for every app's account screens, igt's
// admin panel included. It was lost once when the screens moved into plaid-ui.
// The number is the server's, read from GET /info.
const mount = async () => {
  const client = { users: { create: vi.fn(async () => ({})), update: vi.fn(async () => ({})) } };
  const seen = { current: null };
  const Probe = () => {
    seen.current = useUserAdmin({ client, currentUser: { id: 'admin@x.org' } });
    return null;
  };
  const r = await renderComponent(<Probe />);
  return { ...r, client, admin: () => seen.current };
};

beforeEach(() => {
  vi.clearAllMocks();
  limits.passwordMinLength = 8;
});

describe('useUserAdmin passwords', () => {
  it('refuses to create an account with a password under the server minimum', async () => {
    const { admin, step, client } = await mount();
    const fields = { email: 'a@b.org', displayName: '', isAdmin: false };
    await step(() =>
      admin().state.setNewUser({ ...fields, password: 'abc1234', confirmPassword: 'abc1234' }),
    );
    await step(() => admin().state.createUser());
    expect(client.users.create).not.toHaveBeenCalled();
    expect(notifyError).toHaveBeenCalledWith(
      'Password must be at least 8 characters',
      'Check the password',
    );
    await step(() =>
      admin().state.setNewUser({ ...fields, password: 'abc12345', confirmPassword: 'abc12345' }),
    );
    await step(() => admin().state.createUser());
    expect(client.users.create).toHaveBeenCalledTimes(1);
  });

  it('asks the number the server publishes, not a copy of it', async () => {
    limits.passwordMinLength = 12;
    const { admin, step, client } = await mount();
    const fields = { email: 'a@b.org', displayName: '', isAdmin: false };
    await step(() =>
      admin().state.setNewUser({ ...fields, password: 'abc12345', confirmPassword: 'abc12345' }),
    );
    await step(() => admin().state.createUser());
    expect(client.users.create).not.toHaveBeenCalled();
    expect(notifyError).toHaveBeenCalledWith(
      'Password must be at least 12 characters',
      'Check the password',
    );
  });

  it('refuses a short new password on an edit, and leaves a blank one alone', async () => {
    const { admin, step, client } = await mount();
    const user = { id: 'u@b.org', displayName: 'U', isAdmin: false };
    await step(() => admin().startEdit(user));
    await step(() =>
      admin().state.setEditForm({
        displayName: 'U',
        password: 'abc1234',
        confirmPassword: 'abc1234',
        isAdmin: false,
      }),
    );
    await step(() => admin().state.updateUser());
    expect(client.users.update).not.toHaveBeenCalled();
    await step(() =>
      admin().state.setEditForm({
        displayName: 'V',
        password: '',
        confirmPassword: '',
        isAdmin: false,
      }),
    );
    await step(() => admin().state.updateUser());
    expect(client.users.update).toHaveBeenCalledTimes(1);
  });
});

describe('useUserAdmin emails', () => {
  it('creates the account under the lowercased, trimmed address and names it so', async () => {
    const { notifySuccess } = await import('../lib/notify.js');
    const { admin, step, client } = await mount();
    await step(() =>
      admin().state.setNewUser({
        email: '  Ana@Example.ORG ',
        displayName: '',
        isAdmin: false,
        password: 'abc12345',
        confirmPassword: 'abc12345',
      }),
    );
    await step(() => admin().state.createUser());
    expect(client.users.create).toHaveBeenCalledWith(
      'ana@example.org',
      'abc12345',
      false,
      undefined,
    );
    expect(notifySuccess).toHaveBeenCalledWith('User "ana@example.org" created', 'User created');
  });
});
