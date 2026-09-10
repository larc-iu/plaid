import { useState, useEffect, useCallback } from 'react';
import { Link2, Plus } from 'lucide-react';
import { MintedLinkModal } from '../projects/ProjectInvites';
import { useAuth } from '../../contexts/AuthContext';
import { notifySuccess, notifyError } from '../../utils/feedback.jsx';
import { useConfirm } from '@ui/components/shared/ConfirmProvider';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { isEmail, EMAIL_INVALID_MESSAGE } from '../../utils/email';
import { UserAvatar } from '@ui/components/shared/UserAvatar';
import { Badge } from '@ui/components/ui/badge';
import { Button } from '@ui/components/ui/button';
import { DataTable } from '@ui/components/ui/data-table';
import { Input } from '@ui/components/ui/input';
import { Label } from '@ui/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@ui/components/ui/dialog';

const EMPTY_USER_FORM = {
  email: '',
  displayName: '',
  password: '',
  confirmPassword: '',
  isAdmin: false,
};

const Alert = ({ children }) => (
  <div
    role="alert"
    className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
  >
    {children}
  </div>
);

const Checkbox = ({ id, checked, onChange, disabled, label, description }) => (
  <div className="flex flex-col gap-1">
    <label className="flex cursor-pointer items-center gap-2 text-sm">
      <input
        id={id}
        type="checkbox"
        className="h-4 w-4 cursor-pointer accent-primary"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      {label}
    </label>
    {description && <p className="text-xs text-muted-foreground">{description}</p>}
  </div>
);

// Instance-wide user administration (admin only). Unlike ProjectManagement —
// which resolves a single project's ACL — this browses the whole directory and
// offers create / edit / deactivate / reactivate. Deactivation is a soft-delete
// (client.users.delete); the user stays in listings with a `deactivatedAt`
// timestamp and is reversible.
//
// The whole directory is fetched at once (`users.list()` follows every cursor)
// and filtered, sorted and paged locally by the shared DataTable. This replaced
// server-side keyset paging with a debounced `?q=`: a local filter costs no
// round trip per keystroke, and it is what makes the list sortable and
// countable, which a cursor-paged list with no total cannot be. Same shape as
// plaid-igt's AdminUsers.
export const AdminUsers = () => {
  useDocumentTitle('User Administration');
  const { user, getClient } = useAuth();
  const confirm = useConfirm();
  const isAdmin = user?.isAdmin || false;

  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);

  // Create-user form state
  const [showCreateUserForm, setShowCreateUserForm] = useState(false);
  const [newUserForm, setNewUserForm] = useState(EMPTY_USER_FORM);
  const [createUserError, setCreateUserError] = useState('');
  const [createUserLoading, setCreateUserLoading] = useState(false);

  // Admin-issued password reset link, shown once after minting.
  const [resetCode, setResetCode] = useState(null);
  const [resetting, setResetting] = useState(false);

  // Edit-user form state
  const [editingUser, setEditingUser] = useState(null);
  const [editUserForm, setEditUserForm] = useState(EMPTY_USER_FORM);
  const [editUserError, setEditUserError] = useState('');
  const [editUserLoading, setEditUserLoading] = useState(false);

  const load = useCallback(async () => {
    if (!isAdmin) return;
    setLoading(true);
    try {
      setUsers((await getClient().users.list()) || []);
    } catch (err) {
      console.error('Failed to load users:', err);
      notifyError('Failed to load users');
      setUsers([]);
    } finally {
      setLoading(false);
    }
  }, [isAdmin, getClient]);

  useEffect(() => {
    load();
  }, [load]);

  const handleCreateUser = async (e) => {
    e.preventDefault();
    setCreateUserError('');

    if (!isEmail(newUserForm.email)) {
      setCreateUserError(EMAIL_INVALID_MESSAGE);
      return;
    }
    if (newUserForm.password !== newUserForm.confirmPassword) {
      setCreateUserError('Passwords do not match');
      return;
    }
    if (newUserForm.password.length < 6) {
      setCreateUserError('Password must be at least 6 characters');
      return;
    }

    setCreateUserLoading(true);
    try {
      // The email becomes the account's id and login, permanently. A blank
      // display name lets the server default it to the email's local part.
      await getClient().users.create(
        newUserForm.email,
        newUserForm.password,
        newUserForm.isAdmin,
        newUserForm.displayName.trim() || undefined,
      );
      notifySuccess('User created');
      setShowCreateUserForm(false);
      setNewUserForm(EMPTY_USER_FORM);
      await load();
    } catch (err) {
      console.error('Error creating user:', err);
      if (err.status === 409 || (err.message && err.message.includes('409'))) {
        setCreateUserError(`An account for “${newUserForm.email}” already exists.`);
      } else {
        setCreateUserError('Failed to create user: ' + (err.message || 'Unknown error'));
      }
    } finally {
      setCreateUserLoading(false);
    }
  };

  const startEditingUser = (userToEdit) => {
    setEditUserError('');
    setEditingUser(userToEdit);
    setEditUserForm({
      email: userToEdit.id,
      displayName: userToEdit.displayName,
      password: '',
      confirmPassword: '',
      isAdmin: userToEdit.isAdmin || false,
    });
  };

  const handleUpdateUser = async (e) => {
    e.preventDefault();
    setEditUserError('');

    if (!editUserForm.displayName.trim()) {
      setEditUserError('Enter a display name');
      return;
    }
    if (editUserForm.password && editUserForm.password !== editUserForm.confirmPassword) {
      setEditUserError('Passwords do not match');
      return;
    }
    if (editUserForm.password && editUserForm.password.length < 6) {
      setEditUserError('Password must be at least 6 characters');
      return;
    }

    setEditUserLoading(true);
    try {
      const newDisplayName =
        editUserForm.displayName !== editingUser.displayName ? editUserForm.displayName : undefined;
      const newPassword = editUserForm.password || undefined;
      const newIsAdmin =
        editUserForm.isAdmin !== (editingUser.isAdmin || false) ? editUserForm.isAdmin : undefined;

      await getClient().users.update(editingUser.id, newPassword, newDisplayName, newIsAdmin);
      notifySuccess('User updated');
      setEditingUser(null);
      setEditUserForm(EMPTY_USER_FORM);
      await load();
    } catch (err) {
      console.error('Error updating user:', err);
      setEditUserError('Failed to update user: ' + (err.message || 'Unknown error'));
    } finally {
      setEditUserLoading(false);
    }
  };

  const handleDeactivate = async (target) => {
    const ok = await confirm({
      title: `Deactivate ${target.displayName}`,
      description:
        'They cannot log in, and their project memberships, vocab maintainerships and API ' +
        'tokens are revoked. Reactivating restores the account, not the grants.',
      confirmLabel: 'Deactivate',
      destructive: true,
    });
    if (!ok) return;
    try {
      await getClient().users.delete(target.id);
      notifySuccess('User deactivated');
      setEditingUser(null);
      await load();
    } catch (err) {
      console.error('Error deactivating user:', err);
      notifyError('Failed to deactivate user: ' + (err.message || 'Unknown error'));
    }
  };

  // Mint a one-time link that lets the user set their own password. The point
  // is that the admin never learns (or has to transmit) a password that then
  // has to be trusted to get changed — the user picks their own, once.
  const handleResetLink = async (target) => {
    try {
      setResetting(true);
      const inv = await getClient().invites.create({ targetUserId: target.id });
      setResetCode(inv.code);
    } catch (err) {
      console.error('Error creating reset link:', err);
      notifyError(err.message || 'Failed to create a password reset link');
    } finally {
      setResetting(false);
    }
  };

  const handleReactivate = async (target) => {
    try {
      await getClient().users.activate(target.id);
      notifySuccess('User reactivated');
      setEditingUser(null);
      await load();
    } catch (err) {
      console.error('Error reactivating user:', err);
      notifyError('Failed to reactivate user: ' + (err.message || 'Unknown error'));
    }
  };

  if (!isAdmin) {
    return (
      <div className="tw">
        <Alert>You do not have permission to manage users.</Alert>
      </div>
    );
  }

  const columns = [
    {
      key: 'user',
      label: 'User',
      sort: (u) => (u.displayName || '').toLowerCase(),
      className: 'p-0',
      render: (u) => (
        <button
          type="button"
          className="flex w-full items-center gap-2 px-3 py-2 text-left"
          onClick={() => startEditingUser(u)}
        >
          <UserAvatar
            client={getClient()}
            userId={u.id}
            displayName={u.displayName}
            avatarHash={u.avatarHash}
            className="h-7 w-7"
            fallbackClassName="text-[10px]"
          />
          <span className="min-w-0">
            <span className="flex items-center gap-2">
              <span className="truncate text-sm font-medium">{u.displayName}</span>
              {u.isAdmin && <Badge variant="secondary">Admin</Badge>}
              {u.id === user.id && <Badge variant="outline">You</Badge>}
            </span>
            <span className="block truncate text-xs text-muted-foreground">{u.id}</span>
          </span>
        </button>
      ),
    },
    {
      key: 'status',
      label: 'Status',
      sort: (u) => (u.deactivatedAt ? 1 : 0),
      headerClassName: 'w-32',
      render: (u) =>
        u.deactivatedAt ? (
          <Badge
            variant="outline"
            className="border-destructive/40 bg-destructive/10 text-destructive"
          >
            Deactivated
          </Badge>
        ) : (
          <Badge
            variant="outline"
            className="border-emerald-500/40 bg-emerald-500/10 text-emerald-700"
          >
            Active
          </Badge>
        ),
    },
  ];

  return (
    <div className="tw">
      <div className="mb-6 flex items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">User Administration</h1>
          <p className="text-sm text-muted-foreground">
            Create, edit and deactivate user accounts across the instance.
          </p>
        </div>
        <Button
          onClick={() => {
            setNewUserForm(EMPTY_USER_FORM);
            setShowCreateUserForm(true);
            setCreateUserError('');
          }}
        >
          <Plus className="h-4 w-4" /> Create user
        </Button>
      </div>

      <DataTable
        rows={users}
        columns={columns}
        rowKey={(u) => u.id}
        id="admin-users"
        rememberPage
        defaultSort={{ key: 'user', dir: 'asc' }}
        search={{
          placeholder: 'Search users by name…',
          match: (u, q) =>
            (u.displayName || '').toLowerCase().includes(q) ||
            (u.id || '').toLowerCase().includes(q),
        }}
        noun="user"
        loading={loading}
        empty="No users found."
      />

      {/* Create user */}
      <Dialog
        open={showCreateUserForm}
        onOpenChange={(open) => {
          if (!open) {
            setShowCreateUserForm(false);
            setCreateUserError('');
          }
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>New user</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleCreateUser} className="flex flex-col gap-4">
            {createUserError && <Alert>{createUserError}</Alert>}

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="new-email">Email address</Label>
              <Input
                id="new-email"
                type="email"
                placeholder="e.g. john.doe@example.com"
                value={newUserForm.email}
                onChange={(e) => setNewUserForm((prev) => ({ ...prev, email: e.target.value }))}
                autoFocus
              />
              <p className="text-xs text-muted-foreground">
                What they sign in with. It cannot be changed later.
              </p>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="new-display-name">Display name</Label>
              <Input
                id="new-display-name"
                placeholder="e.g. John Doe"
                value={newUserForm.displayName}
                onChange={(e) =>
                  setNewUserForm((prev) => ({ ...prev, displayName: e.target.value }))
                }
              />
              <p className="text-xs text-muted-foreground">
                How they appear to everyone else. Defaults to the part before the @.
              </p>
            </div>

            <Checkbox
              id="new-is-admin"
              label="Admin"
              checked={newUserForm.isAdmin}
              onChange={(v) => setNewUserForm((prev) => ({ ...prev, isAdmin: v }))}
            />

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="new-password">Password</Label>
              <Input
                id="new-password"
                type="password"
                value={newUserForm.password}
                onChange={(e) => setNewUserForm((prev) => ({ ...prev, password: e.target.value }))}
                autoComplete="new-password"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="new-password-confirm">Confirm password</Label>
              <Input
                id="new-password-confirm"
                type="password"
                value={newUserForm.confirmPassword}
                onChange={(e) =>
                  setNewUserForm((prev) => ({ ...prev, confirmPassword: e.target.value }))
                }
                autoComplete="new-password"
              />
            </div>

            <DialogFooter>
              <Button type="submit" disabled={createUserLoading}>
                {createUserLoading ? 'Creating…' : 'Create user'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Edit user */}
      <Dialog open={!!editingUser} onOpenChange={(open) => !open && setEditingUser(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{editingUser ? editingUser.displayName : ''}</DialogTitle>
          </DialogHeader>
          {editingUser && (
            <form onSubmit={handleUpdateUser} className="flex flex-col gap-4">
              {editUserError && <Alert>{editUserError}</Alert>}

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="edit-email">Email address</Label>
                <Input id="edit-email" value={editUserForm.email} disabled readOnly />
                <p className="text-xs text-muted-foreground">
                  Fixed for the life of the account. It is what they sign in with.
                </p>
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="edit-display-name">Display name</Label>
                <Input
                  id="edit-display-name"
                  value={editUserForm.displayName}
                  onChange={(e) =>
                    setEditUserForm((prev) => ({ ...prev, displayName: e.target.value }))
                  }
                  autoFocus
                />
              </div>

              <Checkbox
                id="edit-is-admin"
                label="Admin"
                checked={editUserForm.isAdmin}
                disabled={editingUser.id === user.id}
                description={
                  editingUser.id === user.id
                    ? 'You cannot change your own admin status.'
                    : undefined
                }
                onChange={(v) => setEditUserForm((prev) => ({ ...prev, isAdmin: v }))}
              />

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="edit-password">New password</Label>
                <Input
                  id="edit-password"
                  type="password"
                  value={editUserForm.password}
                  onChange={(e) =>
                    setEditUserForm((prev) => ({ ...prev, password: e.target.value }))
                  }
                  autoComplete="new-password"
                />
                <p className="text-xs text-muted-foreground">
                  Leave blank to keep the current one.
                </p>
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="edit-password-confirm">Confirm new password</Label>
                <Input
                  id="edit-password-confirm"
                  type="password"
                  value={editUserForm.confirmPassword}
                  onChange={(e) =>
                    setEditUserForm((prev) => ({ ...prev, confirmPassword: e.target.value }))
                  }
                  autoComplete="new-password"
                />
              </div>

              {!editingUser.deactivatedAt && (
                <Button
                  type="button"
                  variant="outline"
                  className="self-start"
                  disabled={resetting}
                  onClick={() => handleResetLink(editingUser)}
                >
                  <Link2 className="h-4 w-4" />
                  {resetting ? 'Creating…' : 'Create password reset link'}
                </Button>
              )}

              <div className="flex items-center justify-between gap-2 pt-1">
                {editingUser.deactivatedAt ? (
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => handleReactivate(editingUser)}
                  >
                    Reactivate
                  </Button>
                ) : (
                  <Button
                    type="button"
                    variant="ghost"
                    className="text-destructive"
                    disabled={editingUser.id === user.id}
                    onClick={() => handleDeactivate(editingUser)}
                  >
                    Deactivate
                  </Button>
                )}
                <div className="flex gap-2">
                  <Button type="button" variant="outline" onClick={() => setEditingUser(null)}>
                    Cancel
                  </Button>
                  <Button type="submit" disabled={editUserLoading}>
                    {editUserLoading ? 'Saving…' : 'Update user'}
                  </Button>
                </div>
              </div>
            </form>
          )}
        </DialogContent>
      </Dialog>

      <MintedLinkModal
        code={resetCode}
        onClose={() => setResetCode(null)}
        title="Password reset link created"
      />
    </div>
  );
};
