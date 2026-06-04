import { useState, useMemo, memo } from 'react';
import { Copy, Check, UserPlus, Trash2, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/dialog';
import { notifySuccess, notifyError } from '@/utils/feedback';

export const AccessManagement = memo(({
  project,
  users,
  user,
  projectId,
  client,
  onDataUpdate,
  onUsersUpdate
}) => {
  const [copied, setCopied] = useState(false);
  const [updatingUser, setUpdatingUser] = useState(null);
  const [hoveredUser, setHoveredUser] = useState(null);
  const [addUserModalOpened, setAddUserModalOpened] = useState(false);
  const openAddUserModal = () => setAddUserModalOpened(true);
  const closeAddUserModal = () => setAddUserModalOpened(false);
  const [deleteUserModalOpened, setDeleteUserModalOpened] = useState(false);
  const openDeleteUserModal = () => setDeleteUserModalOpened(true);
  const closeDeleteUserModal = () => setDeleteUserModalOpened(false);
  const [newUserData, setNewUserData] = useState({
    username: '',
    password: '',
    isAdmin: false
  });
  const [userToDelete, setUserToDelete] = useState(null);
  const [deleteConfirmationText, setDeleteConfirmationText] = useState('');
  const [creatingUser, setCreatingUser] = useState(false);
  const [deletingUser, setDeletingUser] = useState(false);

  // Get user's role in the project
  const getUserRole = (userId) => {
    if (!project) return 'none';
    if (project.maintainers?.includes(userId)) return 'maintainer';
    if (project.writers?.includes(userId)) return 'writer';
    if (project.readers?.includes(userId)) return 'reader';
    return 'none';
  };

  const handleRoleChange = async (userId, newRole) => {
    if (userId === user.id) {
      notifyError('You cannot change your own role in the project', 'Cannot modify own permissions');
      return;
    }

    try {
      setUpdatingUser(userId);
      if (!client) {
        throw new Error('Not authenticated');
      }

      // Add new permission (if not 'none'). Old permission is automatically unassigned on addition,
      // and removing reader removes all other permissions.
      if (newRole === 'maintainer') {
        await client.projects.addMaintainer(projectId, userId);
      } else if (newRole === 'writer') {
        await client.projects.addWriter(projectId, userId);
      } else if (newRole === 'reader') {
        await client.projects.addReader(projectId, userId);
      } else if (newRole === 'none') {
        await client.projects.removeReader(projectId, userId);
      }

      // Refresh project data to update permissions
      await onDataUpdate();

      notifySuccess(`User role has been updated to ${newRole}`, 'Role updated');
    } catch (err) {
      console.error('Error updating role:', err);
      notifyError('Failed to update user role', 'Error');
    } finally {
      setUpdatingUser(null);
    }
  };

  const handleCopyToken = () => {
    const token = localStorage.getItem('token');
    if (token) {
      navigator.clipboard.writeText(token);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      notifySuccess('Your authentication token has been copied to clipboard', 'Token copied');
    }
  };

  const handleAddUser = async () => {
    if (!newUserData.username || !newUserData.password) {
      notifyError('Please provide both Username and Password', 'Missing Information');
      return;
    }

    try {
      setCreatingUser(true);
      if (!client) {
        throw new Error('Not authenticated');
      }

      // Create the user
      await client.users.create(newUserData.username, newUserData.password, newUserData.isAdmin);

      // Refresh the users list
      await onUsersUpdate();

      notifySuccess(`User "${newUserData.username}" has been created successfully`, 'User created');

      // Reset form and close modal
      setNewUserData({ username: '', password: '', isAdmin: false });
      closeAddUserModal();

    } catch (err) {
      console.error('Error creating user:', err);
      notifyError('Failed to create user. Please try again.', 'Error');
    } finally {
      setCreatingUser(false);
    }
  };

  const handleAddUserModalOpen = () => {
    setNewUserData({ username: '', password: '', isAdmin: false });
    openAddUserModal();
  };

  const handleDeleteUserClick = (userId, username) => {
    if (userId === user.id) {
      notifyError('You cannot delete your own user account', 'Cannot delete own account');
      return;
    }

    setUserToDelete({ id: userId, username });
    setDeleteConfirmationText('');
    openDeleteUserModal();
  };

  const handleDeleteUser = async () => {
    if (!userToDelete) return;

    if (deleteConfirmationText !== userToDelete.id) {
      notifyError('User ID does not match. Please type the exact user ID.', 'Invalid confirmation');
      return;
    }

    try {
      setDeletingUser(true);
      if (!client) {
        throw new Error('Not authenticated');
      }

      // Delete the user
      await client.users.delete(userToDelete.id);

      // Refresh the users list
      await onUsersUpdate();

      notifySuccess(`User "${userToDelete.username}" has been deleted successfully`, 'User deleted');

      // Close modal and reset state
      closeDeleteUserModal();
      setUserToDelete(null);
      setDeleteConfirmationText('');

    } catch (err) {
      console.error('Error deleting user:', err);
      notifyError('Failed to delete user. Please try again.', 'Error');
    } finally {
      setDeletingUser(false);
    }
  };

  // Prepare table data with user roles - memoized to prevent unnecessary re-renders
  const tableData = useMemo(() => {
    const data = users.map(u => ({
      ...u,
      role: getUserRole(u.id)
    }));

    // Sort by: 1) Admin status (admins first), 2) Role priority (maintainer > writer > reader > none), 3) Username alphabetically
    const roleMap = { maintainer: 3, writer: 2, reader: 1, none: 0 };
    data.sort((a, b) => {
      // First sort by admin status (admins first)
      if (a.isAdmin !== b.isAdmin) {
        return b.isAdmin - a.isAdmin;
      }

      // Then sort by role priority (higher number = higher priority)
      const roleA = roleMap[a.role] || 0;
      const roleB = roleMap[b.role] || 0;
      if (roleA !== roleB) {
        return roleB - roleA;
      }

      // Finally sort by username alphabetically
      return a.username.localeCompare(b.username);
    });

    return data;
  }, [users, project]);

  return (
    <div className="tw flex flex-col gap-6 pt-4">
      {/* User Management Section */}
      <div className="rounded-lg border bg-card p-4">
        <div className="mb-4 flex items-center justify-between gap-2">
          <h2 className="text-lg font-semibold">User Management</h2>
          {user.isAdmin && (
            <Button onClick={handleAddUserModalOpen}>
              <UserPlus className="h-4 w-4" /> Add User
            </Button>
          )}
        </div>

        <table className="w-full text-sm">
          <thead>
            <tr>
              <th className="px-3 py-2 text-left font-medium">User ID</th>
              <th className="px-3 py-2 text-left font-medium">Username</th>
              <th className="px-3 py-2 text-left font-medium">Admin Status</th>
              <th className="px-3 py-2 text-left font-medium">Project Role</th>
            </tr>
          </thead>
          <tbody>
            {tableData.map(record => (
              <tr key={record.id} className="group border-t hover:bg-muted/50">
                <td className="px-3 py-2">
                  <span className="text-muted-foreground">{record.id}</span>
                </td>
                <td className="px-3 py-2">{record.username}</td>
                <td className="px-3 py-2">
                  {record.isAdmin ? (
                    <Badge variant="destructive">Admin</Badge>
                  ) : (
                    <Badge variant="secondary">User</Badge>
                  )}
                </td>
                <td className="px-3 py-2">
                  <div
                    className="flex items-center justify-between gap-2"
                    onMouseEnter={() => setHoveredUser(record.id)}
                    onMouseLeave={() => setHoveredUser(null)}
                  >
                    <Select
                      value={record.isAdmin && "admin" || record.role}
                      onValueChange={(value) => handleRoleChange(record.id, value)}
                      disabled={updatingUser === record.id || record.id === user.id || record.isAdmin}
                    >
                      <SelectTrigger className="h-8 flex-1">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {[
                          { value: 'none', label: 'No Access' },
                          { value: 'reader', label: 'Reader' },
                          { value: 'writer', label: 'Writer' },
                          { value: 'maintainer', label: 'Maintainer' },
                        ].map(o => (
                          <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {user.isAdmin && (
                      <Button
                        size="icon"
                        variant="destructive"
                        className={`h-8 w-8 shrink-0 transition-opacity ${record.id !== user.id ? 'group-hover:opacity-100' : ''} opacity-0`}
                        onClick={(event) => {
                          event.stopPropagation();
                          handleDeleteUserClick(record.id, record.username);
                        }}
                        disabled={deletingUser}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="border-t" />

      {/* API Token Section */}
      <div className="rounded-lg border bg-card p-4">
        <h2 className="mb-4 text-lg font-semibold">API Token</h2>
        <p className="mb-4 text-sm">
          Use your authentication token to access the API programmatically from external services like parsers or scripts.
        </p>

        <div className="flex items-center gap-2">
          <Button onClick={handleCopyToken}>
            {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
            {copied ? 'Copied!' : 'Copy Token'}
          </Button>
        </div>

        <p className="mt-4 text-xs text-muted-foreground">
          Keep your token secure. You can use it to initialize a Python PlaidClient instance.
        </p>
      </div>

      {/* Add User Modal */}
      <Dialog open={addUserModalOpened} onOpenChange={(o) => { if (!o) closeAddUserModal(); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Add New User</DialogTitle>
          </DialogHeader>

          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label>Username</Label>
              <Input
                placeholder="Enter username"
                value={newUserData.username}
                onChange={(event) => setNewUserData({ ...newUserData, username: event.target.value })}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label>Password</Label>
              <Input
                placeholder="Enter initial password"
                type="password"
                value={newUserData.password}
                onChange={(event) => setNewUserData({ ...newUserData, password: event.target.value })}
              />
            </div>

            <div className="flex items-start gap-2">
              <Switch
                id="admin"
                checked={newUserData.isAdmin}
                onCheckedChange={(c) => setNewUserData({ ...newUserData, isAdmin: c })}
              />
              <div>
                <Label htmlFor="admin">Admin Status</Label>
                <p className="text-xs text-muted-foreground">Grant this user admin privileges</p>
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={closeAddUserModal}
              disabled={creatingUser}
            >
              Cancel
            </Button>
            <Button
              onClick={handleAddUser}
              disabled={creatingUser}
            >
              {!creatingUser && <UserPlus className="h-4 w-4" />}
              {creatingUser ? 'Creating...' : 'Create User'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete User Modal */}
      <Dialog open={deleteUserModalOpened} onOpenChange={(o) => { if (!o) closeDeleteUserModal(); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Delete User</DialogTitle>
          </DialogHeader>

          <div className="flex flex-col gap-4">
            <div className="rounded-md border border-destructive/50 bg-destructive/5 p-3">
              <div className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                <div className="text-sm">
                  <p className="font-medium text-destructive">Caution</p>
                  <p className="mt-1 text-muted-foreground">
                    You are about to delete user:
                    <br/><br/>
                    <strong>"{userToDelete?.username}"</strong><br/>
                    (<strong>{userToDelete?.id}</strong>)
                  </p>
                </div>
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <p className="text-sm">
                To confirm deletion, please type the user ID <strong>{userToDelete?.id}</strong> below:
              </p>
              <Input
                value={deleteConfirmationText}
                onChange={(event) => setDeleteConfirmationText(event.target.value)}
                placeholder="Enter user ID"
              />
              {deleteConfirmationText && deleteConfirmationText !== userToDelete?.id && (
                <p className="text-xs text-destructive">User ID does not match</p>
              )}
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={closeDeleteUserModal}
              disabled={deletingUser}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDeleteUser}
              disabled={deleteConfirmationText !== userToDelete?.id || deletingUser}
            >
              <Trash2 className="h-4 w-4" />
              {deletingUser ? 'Deleting...' : 'Delete User'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
});
