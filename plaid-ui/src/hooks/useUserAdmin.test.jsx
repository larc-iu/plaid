import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../lib/notify.js', () => ({ notifySuccess: vi.fn(), notifyError: vi.fn() }));

const { notifyError } = await import('../lib/notify.js');
const { renderComponent } = await import('../test/renderComponent.jsx');
const { useUserAdmin } = await import('./useUserAdmin.js');

// The password minimum lives here for every app's account screens, igt's admin
// panel included. It was lost once when the screens moved into plaid-ui.
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

beforeEach(() => vi.clearAllMocks());

describe('useUserAdmin passwords', () => {
  it('refuses to create an account with a password under six characters', async () => {
    const { admin, step, client } = await mount();
    const fields = { email: 'a@b.org', displayName: '', isAdmin: false };
    await step(() =>
      admin().state.setNewUser({ ...fields, password: 'abc12', confirmPassword: 'abc12' }),
    );
    await step(() => admin().state.createUser());
    expect(client.users.create).not.toHaveBeenCalled();
    expect(notifyError).toHaveBeenCalledWith(
      'Password must be at least 6 characters long',
      'Check the password',
    );
    await step(() =>
      admin().state.setNewUser({ ...fields, password: 'abc123', confirmPassword: 'abc123' }),
    );
    await step(() => admin().state.createUser());
    expect(client.users.create).toHaveBeenCalledTimes(1);
  });

  it('refuses a short new password on an edit, and leaves a blank one alone', async () => {
    const { admin, step, client } = await mount();
    const user = { id: 'u@b.org', displayName: 'U', isAdmin: false };
    await step(() => admin().startEdit(user));
    await step(() =>
      admin().state.setEditForm({
        displayName: 'U',
        password: 'abc',
        confirmPassword: 'abc',
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
