import { useState, useEffect } from 'react';
import { UserPlus, Search, Plus, MoreVertical } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import {
  Dialog, DialogContent, DialogHeader, DialogFooter, DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
} from '@/components/ui/dropdown-menu';
import {
  AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogFooter,
  AlertDialogTitle, AlertDialogDescription, AlertDialogAction, AlertDialogCancel,
} from '@/components/ui/alert-dialog';
import { notifySuccess, notifyError } from '@/utils/feedback';

// Mirrors plaid-ud's ProjectManagement. The full user roster isn't fetched
// (doesn't scale + is admin-gated); instead "Members" come from the project's
// ACL and new grants come from a server-side `?q=` search.
const ROLE_OPTIONS = [
  { value: 'none', label: 'No access' },
  { value: 'reader', label: 'Reader' },
  { value: 'writer', label: 'Writer' },
  { value: 'maintainer', label: 'Maintainer' },
];
const GRANT_ROLES = ['reader', 'writer', 'maintainer'];
const SEARCH_LIMIT = 25;
const EMPTY_USER = { username: '', password: '', isAdmin: false };

const roleOf = (project, userId) => {
  if (project?.maintainers?.includes(userId)) return 'maintainer';
  if (project?.writers?.includes(userId)) return 'writer';
  if (project?.readers?.includes(userId)) return 'reader';
  return 'none';
};
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

export const AccessManagement = ({ project, user, projectId, client, onDataUpdate }) => {
  const isAdmin = !!user?.isAdmin;

  // Members (explicitly-granted users, resolved from the ACL — admins who were
  // explicitly added show with a badge; implicit admins never appear).
  const [members, setMembers] = useState([]);
  const [membersLoading, setMembersLoading] = useState(true);
  const [updatingUser, setUpdatingUser] = useState(null);

  // Search-to-add.
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [searchActive, setSearchActive] = useState(false);
  const [searchResults, setSearchResults] = useState([]);
  const [searchLoading, setSearchLoading] = useState(false);

  // Admin user CRUD.
  const [createOpen, setCreateOpen] = useState(false);
  const [newUser, setNewUser] = useState(EMPTY_USER);
  const [creating, setCreating] = useState(false);
  const [editingUser, setEditingUser] = useState(null);
  const [editForm, setEditForm] = useState(EMPTY_USER);
  const [savingEdit, setSavingEdit] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 250);
    return () => clearTimeout(t);
  }, [search]);

  // Resolve ACL member ids to user objects (project-sized, so per-id GETs are fine).
  useEffect(() => {
    if (!project) return;
    let cancelled = false;
    (async () => {
      setMembersLoading(true);
      const ids = [...new Set([
        ...(project.maintainers || []),
        ...(project.writers || []),
        ...(project.readers || []),
      ])];
      try {
        const resolved = await Promise.all(ids.map(id =>
          client.users.get(id).catch(() => ({ id, username: id, isAdmin: false }))));
        const rows = resolved
          .map(u => ({ ...u, role: roleOf(project, u.id) }))
          .sort((a, b) => (a.username || '').localeCompare(b.username || ''));
        if (!cancelled) setMembers(rows);
      } catch (err) {
        console.error('Error resolving members:', err);
        if (!cancelled) setMembers([]);
      } finally {
        if (!cancelled) setMembersLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [project, client]);

  // Server-side search (?q=). Runs once the box is touched; empty browses the
  // first page. Members already on the project are dropped.
  useEffect(() => {
    if (!searchActive) return;
    let cancelled = false;
    (async () => {
      setSearchLoading(true);
      try {
        const page = await client.users.listPage({ q: debouncedSearch || undefined, limit: SEARCH_LIMIT });
        const memberIds = new Set(members.map(m => m.id));
        const results = (page.entries || []).filter(u => !memberIds.has(u.id));
        if (!cancelled) setSearchResults(results);
      } catch (err) {
        console.error('User search failed:', err);
        if (!cancelled) setSearchResults([]);
      } finally {
        if (!cancelled) setSearchLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [debouncedSearch, searchActive, members, client]);

  const setRole = async (userId, newRole) => {
    if (userId === user.id) {
      notifyError('You cannot change your own role', 'Cannot modify own permissions');
      return;
    }
    const current = roleOf(project, userId);
    if (current === newRole) return;
    try {
      setUpdatingUser(userId);
      if (current === 'maintainer') await client.projects.removeMaintainer(projectId, userId);
      else if (current === 'writer') await client.projects.removeWriter(projectId, userId);
      else if (current === 'reader') await client.projects.removeReader(projectId, userId);

      if (newRole === 'maintainer') await client.projects.addMaintainer(projectId, userId);
      else if (newRole === 'writer') await client.projects.addWriter(projectId, userId);
      else if (newRole === 'reader') await client.projects.addReader(projectId, userId);

      await onDataUpdate(); // re-resolves members
      notifySuccess('Permissions updated', 'Success');
    } catch (err) {
      console.error('Error updating role:', err);
      notifyError('Failed to update permissions', 'Error');
    } finally {
      setUpdatingUser(null);
    }
  };

  const handleCreateUser = async () => {
    if (!newUser.username || !newUser.password) {
      notifyError('Please provide both a username and password', 'Missing information');
      return;
    }
    try {
      setCreating(true);
      await client.users.create(newUser.username, newUser.password, newUser.isAdmin);
      notifySuccess(`User "${newUser.username}" created`, 'User created');
      setNewUser(EMPTY_USER);
      setCreateOpen(false);
    } catch (err) {
      console.error('Error creating user:', err);
      const exists = err.status === 409 || (err.message && err.message.includes('409'));
      notifyError(exists ? `A user "${newUser.username}" already exists.` : 'Failed to create user.', 'Error');
    } finally {
      setCreating(false);
    }
  };

  const startEdit = (u) => {
    setEditForm({ username: u.username, password: '', isAdmin: u.isAdmin || false });
    setEditingUser(u);
  };

  const handleUpdateUser = async () => {
    try {
      setSavingEdit(true);
      const newUsername = editForm.username !== editingUser.username ? editForm.username : undefined;
      const newPassword = editForm.password || undefined;
      const newIsAdmin = editForm.isAdmin !== (editingUser.isAdmin || false) ? editForm.isAdmin : undefined;
      await client.users.update(editingUser.id, newPassword, newUsername, newIsAdmin);
      notifySuccess('User updated', 'Success');
      setEditingUser(null);
      await onDataUpdate();
    } catch (err) {
      console.error('Error updating user:', err);
      notifyError('Failed to update user: ' + (err.message || 'Unknown error'), 'Error');
    } finally {
      setSavingEdit(false);
    }
  };

  const handleDeleteUser = async () => {
    if (!deleteTarget) return;
    try {
      setDeleting(true);
      await client.users.delete(deleteTarget.id);
      notifySuccess(`User "${deleteTarget.username}" deleted`, 'User deleted');
      setDeleteTarget(null);
      setEditingUser(null);
      await onDataUpdate();
    } catch (err) {
      console.error('Error deleting user:', err);
      notifyError('Failed to delete user: ' + (err.message || 'Unknown error'), 'Error');
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="tw flex flex-col gap-6 pt-4">
      {/* Members */}
      <div className="rounded-lg border bg-card">
        <div className="flex items-center justify-between gap-2 border-b px-4 py-3">
          <h2 className="text-lg font-semibold">Members</h2>
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">{members.length} with access</span>
            {isAdmin && (
              <Button size="sm" onClick={() => { setNewUser(EMPTY_USER); setCreateOpen(true); }}>
                <UserPlus className="h-4 w-4" /> Create User
              </Button>
            )}
          </div>
        </div>

        {membersLoading ? (
          <div className="flex justify-center py-8 text-muted-foreground">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-muted border-t-primary" />
          </div>
        ) : members.length === 0 ? (
          <p className="px-4 py-4 text-sm text-muted-foreground">
            No one has been granted access yet. Use “Add a user” below.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-muted-foreground">
                <th className="px-4 py-2 font-medium">User</th>
                <th className="px-4 py-2 font-medium">Project role</th>
                {isAdmin && <th className="w-12 px-4 py-2" />}
              </tr>
            </thead>
            <tbody>
              {members.map(m => (
                <tr key={m.id} className="border-t">
                  <td className="px-4 py-2">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{m.username}</span>
                      {m.isAdmin && <Badge variant="secondary">Admin</Badge>}
                    </div>
                    <span className="text-xs text-muted-foreground">{m.id}</span>
                  </td>
                  <td className="px-4 py-2">
                    <Select
                      value={m.role}
                      onValueChange={(v) => setRole(m.id, v)}
                      disabled={m.id === user.id || updatingUser === m.id}
                    >
                      <SelectTrigger className="h-8 w-40"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {ROLE_OPTIONS.map(o => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </td>
                  {isAdmin && (
                    <td className="px-4 py-2">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="User actions">
                            <MoreVertical className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onSelect={() => startEdit(m)}>Edit user…</DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Add a user (server-side search) */}
      <div className="rounded-lg border bg-card">
        <div className="border-b px-4 py-3">
          <h2 className="text-lg font-semibold">Add a user</h2>
        </div>
        <div className="flex flex-col gap-2 px-4 py-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              className="pl-8"
              placeholder="Search users by name…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onFocus={() => setSearchActive(true)}
            />
          </div>

          {searchActive && (
            searchLoading ? (
              <div className="flex justify-center py-4 text-muted-foreground">
                <div className="h-5 w-5 animate-spin rounded-full border-2 border-muted border-t-primary" />
              </div>
            ) : searchResults.length === 0 ? (
              <p className="py-1 text-sm text-muted-foreground">
                {debouncedSearch ? 'No matching users.' : 'No other users to add.'}
              </p>
            ) : (
              <div className="flex flex-col">
                {searchResults.map((u, i) => (
                  <div
                    key={u.id}
                    className={`flex items-center justify-between gap-2 py-2 ${i ? 'border-t' : ''}`}
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="truncate font-medium">{u.username}</span>
                        {u.isAdmin && <Badge variant="secondary">Admin</Badge>}
                      </div>
                      <span className="block truncate text-xs text-muted-foreground">{u.id}</span>
                    </div>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button size="sm" variant="outline"><Plus className="h-4 w-4" /> Add</Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuLabel>Add as…</DropdownMenuLabel>
                        {GRANT_ROLES.map(role => (
                          <DropdownMenuItem key={role} onSelect={() => setRole(u.id, role)}>
                            {cap(role)}
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                ))}
              </div>
            )
          )}
        </div>
      </div>

      {/* Create User dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>Create New User</DialogTitle></DialogHeader>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label>User ID</Label>
              <Input
                placeholder="e.g. john.doe"
                value={newUser.username}
                onChange={(e) => setNewUser({ ...newUser, username: e.target.value })}
                autoFocus
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
              <Switch id="new-admin" checked={newUser.isAdmin} onCheckedChange={(c) => setNewUser({ ...newUser, isAdmin: c })} />
              <div>
                <Label htmlFor="new-admin">Admin user</Label>
                <p className="text-xs text-muted-foreground">Grant this user admin privileges</p>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)} disabled={creating}>Cancel</Button>
            <Button onClick={handleCreateUser} disabled={creating}>{creating ? 'Creating…' : 'Create User'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit User dialog */}
      <Dialog open={!!editingUser} onOpenChange={(o) => { if (!o) setEditingUser(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>{editingUser ? `Edit User: ${editingUser.username}` : ''}</DialogTitle></DialogHeader>
          {editingUser && (
            <>
              <div className="flex flex-col gap-4">
                <div className="flex flex-col gap-1.5">
                  <Label>Username</Label>
                  <Input value={editForm.username} onChange={(e) => setEditForm({ ...editForm, username: e.target.value })} />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label>New password (leave blank to keep current)</Label>
                  <Input type="password" value={editForm.password} onChange={(e) => setEditForm({ ...editForm, password: e.target.value })} />
                </div>
                <div className="flex items-start gap-2">
                  <Switch id="edit-admin" checked={editForm.isAdmin} onCheckedChange={(c) => setEditForm({ ...editForm, isAdmin: c })} />
                  <Label htmlFor="edit-admin">Admin user</Label>
                </div>
              </div>
              <DialogFooter className="sm:justify-between">
                <Button
                  variant="destructive"
                  onClick={() => setDeleteTarget(editingUser)}
                  disabled={editingUser.id === user.id || savingEdit}
                >
                  Delete User
                </Button>
                <div className="flex gap-2">
                  <Button variant="outline" onClick={() => setEditingUser(null)} disabled={savingEdit}>Cancel</Button>
                  <Button onClick={handleUpdateUser} disabled={savingEdit}>{savingEdit ? 'Saving…' : 'Update User'}</Button>
                </div>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Delete confirm */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(o) => { if (!o) setDeleteTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete user?</AlertDialogTitle>
            <AlertDialogDescription>
              Permanently delete <strong>{deleteTarget?.username}</strong> ({deleteTarget?.id}). This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => { e.preventDefault(); handleDeleteUser(); }}
              disabled={deleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleting ? 'Deleting…' : 'Delete User'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};
