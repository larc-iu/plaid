import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogAction,
  AlertDialogCancel,
} from '@/components/ui/alert-dialog';
import { notifySuccess, notifyError } from '@/utils/feedback';
import { isEmail, EMAIL_INVALID_MESSAGE } from '@/utils/email';
import { MintedLinkDialog } from '../projects/ProjectInvites';

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

export const UserAdminDialogs = ({ controller }) => {
  const {
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
  } = controller.state;

  return (
    <>
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Create New User</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label>Email address</Label>
              <Input
                type="email"
                placeholder="you@example.com"
                value={newUser.email}
                onChange={(e) => setNewUser({ ...newUser, email: e.target.value })}
                autoFocus
              />
              <p className="text-xs text-muted-foreground">
                What they sign in with. It cannot be changed later.
              </p>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>Display name (optional)</Label>
              <Input
                placeholder="How they appear to everyone else"
                value={newUser.displayName}
                onChange={(e) => setNewUser({ ...newUser, displayName: e.target.value })}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>Password</Label>
              <Input
                type="password"
                value={newUser.password}
                onChange={(e) => setNewUser({ ...newUser, password: e.target.value })}
              />
            </div>
            <div className="flex items-start gap-2">
              <Switch
                id="new-admin"
                checked={newUser.isAdmin}
                onCheckedChange={(c) => setNewUser({ ...newUser, isAdmin: c })}
              />
              <div>
                <Label htmlFor="new-admin">Admin user</Label>
                <p className="text-xs text-muted-foreground">Grant this user admin privileges</p>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)} disabled={creating}>
              Cancel
            </Button>
            <Button onClick={createUser} disabled={creating}>
              {creating ? 'Creating…' : 'Create User'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!editingUser}
        onOpenChange={(o) => {
          if (!o) setEditingUser(null);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{editingUser ? `Edit User: ${editingUser.displayName}` : ''}</DialogTitle>
          </DialogHeader>
          {editingUser && (
            <>
              <div className="flex flex-col gap-4">
                <div className="flex flex-col gap-1.5">
                  <Label>Email address</Label>
                  <Input value={editingUser.id} disabled readOnly />
                  <p className="text-xs text-muted-foreground">
                    Fixed for the life of the account — it is what they sign in with.
                  </p>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label>Display name</Label>
                  <Input
                    value={editForm.displayName}
                    onChange={(e) => setEditForm({ ...editForm, displayName: e.target.value })}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label>New password (leave blank to keep current)</Label>
                  <Input
                    type="password"
                    value={editForm.password}
                    onChange={(e) => setEditForm({ ...editForm, password: e.target.value })}
                  />
                </div>
                <div className="flex items-start gap-2">
                  <Switch
                    id="edit-admin"
                    checked={editForm.isAdmin}
                    onCheckedChange={(c) => setEditForm({ ...editForm, isAdmin: c })}
                  />
                  <Label htmlFor="edit-admin">Admin user</Label>
                </div>
              </div>
              <DialogFooter className="sm:justify-between">
                <Button
                  variant="destructive"
                  onClick={() => setDeactivateTarget(editingUser)}
                  disabled={editingUser.id === currentUser?.id || savingEdit}
                >
                  Deactivate
                </Button>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    onClick={() => setEditingUser(null)}
                    disabled={savingEdit}
                  >
                    Cancel
                  </Button>
                  <Button onClick={updateUser} disabled={savingEdit}>
                    {savingEdit ? 'Saving…' : 'Update User'}
                  </Button>
                </div>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      <MintedLinkDialog
        code={resetCode}
        onClose={() => setResetCode(null)}
        title="Password reset link created"
      />

      <AlertDialog
        open={!!deactivateTarget}
        onOpenChange={(o) => {
          if (!o) setDeactivateTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Deactivate user?</AlertDialogTitle>
            <AlertDialogDescription>
              <strong>{deactivateTarget?.displayName}</strong> ({deactivateTarget?.id}) will be
              signed out, lose every project role and API token, and be refused at login. Their
              annotations and their name on them are untouched. Reactivating restores login only.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deactivating}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                deactivateUser();
              }}
              disabled={deactivating}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deactivating ? 'Deactivating…' : 'Deactivate'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};
