import { useState } from 'react';
import { notifySuccess, notifyError } from '@/utils/feedback';
import { isEmail, EMAIL_INVALID_MESSAGE } from '@/utils/email';

// Account administration, shared by the two screens that do it: the Access tab
// of a project (where an admin creates the account they are about to grant a
// role to) and the Users tab of the admin panel (where the whole directory
// is). One copy of the dialogs, one copy of the rules.
//
// `users.delete` is a DEACTIVATION on the server — logins and tokens are
// refused, memberships are stripped, and the row stays with a timestamp —
// and `users.activate` reverses it. The copy here says so.

const EMPTY_USER = { email: '', displayName: '', password: '', isAdmin: false };

export const useUserAdmin = ({ client, currentUser, onChanged }) => {
  const [createOpen, setCreateOpen] = useState(false);
  const [newUser, setNewUser] = useState(EMPTY_USER);
  const [creating, setCreating] = useState(false);

  const [editingUser, setEditingUser] = useState(null);
  const [editForm, setEditForm] = useState(EMPTY_USER);
  const [savingEdit, setSavingEdit] = useState(false);

  const [deactivateTarget, setDeactivateTarget] = useState(null);
  const [deactivating, setDeactivating] = useState(false);

  const [resetCode, setResetCode] = useState(null);
  const [resetting, setResetting] = useState(false);

  const changed = async () => {
    if (onChanged) await onChanged();
  };

  const openCreate = () => {
    setNewUser(EMPTY_USER);
    setCreateOpen(true);
  };

  const createUser = async () => {
    if (!newUser.email || !newUser.password) {
      notifyError('Please provide both an email address and a password', 'Missing information');
      return;
    }
    if (!isEmail(newUser.email)) {
      notifyError(EMAIL_INVALID_MESSAGE, 'Check the email address');
      return;
    }
    try {
      setCreating(true);
      // The email becomes the account's id and login, permanently. A blank
      // display name lets the server default it to the email's local part.
      await client.users.create(
        newUser.email,
        newUser.password,
        newUser.isAdmin,
        newUser.displayName.trim() || undefined,
      );
      notifySuccess(`User "${newUser.email}" created`, 'User created');
      setNewUser(EMPTY_USER);
      setCreateOpen(false);
      await changed();
    } catch (err) {
      console.error('Error creating user:', err);
      const exists = err.status === 409 || (err.message && err.message.includes('409'));
      notifyError(
        exists ? `An account already exists for ${newUser.email}.` : 'Failed to create user.',
        'Error',
      );
    } finally {
      setCreating(false);
    }
  };

  const startEdit = (u) => {
    setEditForm({ displayName: u.displayName, password: '', isAdmin: u.isAdmin || false });
    setEditingUser(u);
  };

  const updateUser = async () => {
    try {
      setSavingEdit(true);
      const newDisplayName =
        editForm.displayName !== editingUser.displayName ? editForm.displayName : undefined;
      const newPassword = editForm.password || undefined;
      const newIsAdmin =
        editForm.isAdmin !== (editingUser.isAdmin || false) ? editForm.isAdmin : undefined;
      await client.users.update(editingUser.id, newPassword, newDisplayName, newIsAdmin);
      notifySuccess('User updated', 'Success');
      setEditingUser(null);
      await changed();
    } catch (err) {
      console.error('Error updating user:', err);
      notifyError('Failed to update user: ' + (err.message || 'Unknown error'), 'Error');
    } finally {
      setSavingEdit(false);
    }
  };

  // A one-time link the recipient uses to set their own password, instead of
  // the admin inventing a temporary one and sending it over some side channel
  // that then has to be trusted to be cleaned up.
  const createResetLink = async (target) => {
    try {
      setResetting(true);
      const inv = await client.invites.create({ targetUserId: target.id });
      setResetCode(inv.code);
    } catch (err) {
      console.error('Error creating reset link:', err);
      notifyError(err.message || 'Failed to create a password reset link', 'Error');
    } finally {
      setResetting(false);
    }
  };

  const deactivateUser = async () => {
    if (!deactivateTarget) return;
    try {
      setDeactivating(true);
      await client.users.delete(deactivateTarget.id);
      notifySuccess(`${deactivateTarget.displayName} deactivated`, 'User deactivated');
      setDeactivateTarget(null);
      setEditingUser(null);
      await changed();
    } catch (err) {
      console.error('Error deactivating user:', err);
      notifyError('Failed to deactivate user: ' + (err.message || 'Unknown error'), 'Error');
    } finally {
      setDeactivating(false);
    }
  };

  const activateUser = async (target) => {
    try {
      await client.users.activate(target.id);
      notifySuccess(`${target.displayName} reactivated`, 'User reactivated');
      await changed();
    } catch (err) {
      console.error('Error reactivating user:', err);
      notifyError('Failed to reactivate user: ' + (err.message || 'Unknown error'), 'Error');
    }
  };

  return {
    openCreate,
    startEdit,
    createResetLink,
    activateUser,
    resetting,
    // Consumed by <UserAdminDialogs>; a call site never reads these.
    state: {
      currentUser,
      createOpen,
      setCreateOpen,
      newUser,
      setNewUser,
      creating,
      createUser,
      editingUser,
      setEditingUser,
      editForm,
      setEditForm,
      savingEdit,
      updateUser,
      deactivateTarget,
      setDeactivateTarget,
      deactivating,
      deactivateUser,
      resetCode,
      setResetCode,
    },
  };
};
