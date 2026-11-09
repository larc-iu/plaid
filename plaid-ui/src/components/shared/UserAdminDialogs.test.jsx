import { describe, it, expect, vi } from 'vitest';
import { renderComponent } from '../../test/renderComponent.jsx';
import { UserAdminDialogs } from './UserAdminDialogs.jsx';

// The edit dialog an admin opens on a row. Their own password needs the current
// one, which only Profile asks for, so the dialog does not offer it on their row.
const controllerFor = (editingUser) => ({
  state: {
    currentUser: { id: 'admin@x.org' },
    createOpen: false,
    setCreateOpen: vi.fn(),
    newUser: { email: '', displayName: '', password: '', confirmPassword: '', isAdmin: false },
    setNewUser: vi.fn(),
    creating: false,
    createUser: vi.fn(),
    editingUser,
    setEditingUser: vi.fn(),
    editForm: {
      displayName: editingUser.displayName,
      password: '',
      confirmPassword: '',
      isAdmin: true,
    },
    setEditForm: vi.fn(),
    savingEdit: false,
    updateUser: vi.fn(),
    deactivateTarget: null,
    setDeactivateTarget: vi.fn(),
    deactivating: false,
    deactivateUser: vi.fn(),
    resetCode: null,
    setResetCode: vi.fn(),
  },
});

describe('the edit dialog', () => {
  it('offers a new password for someone else', async () => {
    const view = await renderComponent(
      <UserAdminDialogs controller={controllerFor({ id: 'u@x.org', displayName: 'U' })} />,
    );
    expect(document.body.querySelector('#user-admin-edit-password')).not.toBeNull();
    await view.unmount();
  });

  it('sends the admin to Profile for their own password', async () => {
    const view = await renderComponent(
      <UserAdminDialogs controller={controllerFor({ id: 'admin@x.org', displayName: 'A' })} />,
    );
    expect(document.body.querySelector('#user-admin-edit-password')).toBeNull();
    expect(document.body.textContent).toContain('Change your own password on Profile.');
    await view.unmount();
  });
});

describe('the create dialog', () => {
  const open = (projectId) => {
    const c = controllerFor({ id: 'u@x.org', displayName: 'U' });
    return {
      state: {
        ...c.state,
        editingUser: null,
        createOpen: true,
        projectId,
        newUser: { ...c.state.newUser, role: 'writer' },
      },
    };
  };

  it('asks the role in a project', async () => {
    const view = await renderComponent(<UserAdminDialogs controller={open('p1')} />);
    expect(document.body.querySelector('#user-admin-role')).not.toBeNull();
    await view.unmount();
  });

  it('asks no role in the admin area', async () => {
    const view = await renderComponent(<UserAdminDialogs controller={open(undefined)} />);
    expect(document.body.querySelector('#user-admin-role')).toBeNull();
    await view.unmount();
  });
});
