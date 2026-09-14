import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { MoreVertical, Plus } from 'lucide-react';
import { ProjectInvites } from '@ui/components/shared/ProjectInvites.jsx';
import { ProjectMembers } from '@ui/components/shared/ProjectMembers.jsx';
import { MintedLinkDialog } from '@ui/components/shared/MintedLinkDialog.jsx';
import { aclMemberIds, setProjectRoleReporting } from '@ui/domain/projectRoles.js';
import { useAuth } from '../../contexts/AuthContext';
import { notifySuccess, notifyError, humanizeError } from '../../utils/feedback.jsx';
import { useConfirm } from '@ui/components/shared/ConfirmProvider';
import { canManageProject } from '@ui/domain/permissions.js';
import { useLatestCall } from '@ui/hooks/useLatestCall.js';
import { isEmail, EMAIL_INVALID_MESSAGE } from '@ui/lib/email.js';
import { Badge } from '@ui/components/ui/badge';
import { UserAvatar } from '@ui/components/shared/UserAvatar';
import { Button } from '@ui/components/ui/button';
import { Input } from '@ui/components/ui/input';
import { Label } from '@ui/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@ui/components/ui/card';
import { SearchInput, ListHint } from '@ui/components/shared/list-search';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@ui/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@ui/components/ui/dropdown-menu';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@ui/components/ui/select';
import { MAINTAINER_HINT, NO_ACCESS_HINT } from '@ui/domain/permissions.js';

// What each level grants, said where the choice is made. The Invites screen
// says the same three lines, and this screen decides what a class of fifteen
// can do: naming the levels and nothing else left "a Reader cannot comment"
// to be learned by granting someone Reader and hearing about it.
const PERMISSION_OPTIONS = [
  { value: 'none', label: 'No access', hint: NO_ACCESS_HINT },
  { value: 'reader', label: 'Reader', hint: 'Reads the treebank. Cannot comment.' },
  { value: 'writer', label: 'Writer', hint: 'Also edits documents and their annotation.' },
  { value: 'maintainer', label: 'Maintainer', hint: MAINTAINER_HINT },
];
const ROLE_HINTS = Object.fromEntries(
  PERMISSION_OPTIONS.filter((o) => o.value !== 'none').map((o) => [o.value, o.hint]),
);
const GRANT_ROLES = ['reader', 'writer', 'maintainer'];
const SEARCH_LIMIT = 25;

const EMPTY_USER_FORM = {
  email: '',
  displayName: '',
  password: '',
  confirmPassword: '',
  isAdmin: false,
};

export const ProjectManagement = () => {
  const { projectId } = useParams();
  const { user, getClient } = useAuth();
  const confirm = useConfirm();
  const [project, setProject] = useState(null);
  const [loading, setLoading] = useState(true);

  // Search-to-add. The roster isn't fetched wholesale; we query the server.
  const [search, setSearch] = useState('');
  // The directory search hits the server, so it waits for a pause in typing.
  // Four lines rather than a dependency, and the same 250 ms plaid-igt's
  // useUserSearch settled on.
  const [debouncedSearch, setDebouncedSearch] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 250);
    return () => clearTimeout(t);
  }, [search]);
  const [searchActive, setSearchActive] = useState(false);
  const [searchResults, setSearchResults] = useState([]);
  const [searchLoading, setSearchLoading] = useState(false);
  // True when the directory had more matches than SEARCH_LIMIT returned, so
  // the list can say so instead of reading as "no such user".
  const [searchCapped, setSearchCapped] = useState(false);

  // User creation form state
  const [showCreateUserForm, setShowCreateUserForm] = useState(false);
  const [newUserForm, setNewUserForm] = useState(EMPTY_USER_FORM);
  const [createUserError, setCreateUserError] = useState('');
  const [createUserLoading, setCreateUserLoading] = useState(false);

  // User editing state
  const [editingUser, setEditingUser] = useState(null);
  const [editUserForm, setEditUserForm] = useState(EMPTY_USER_FORM);
  const [editUserError, setEditUserError] = useState('');

  // Admin-issued password reset link, shown once after minting.
  const [resetCode, setResetCode] = useState(null);
  const [resetting, setResetting] = useState(false);

  const isAdmin = user?.isAdmin || false;
  // Whether this user can hand out project invites. Maintainers can, which is
  // the point: onboarding a class should not queue behind an admin. The same
  // test as every other maintainer gate, from the one place that owns it: the
  // hand-rolled copy here also missed that the ACL can hold nulls.
  const canInvite = canManageProject(project, user);

  // Mint a one-time link that lets someone set their own password, instead of
  // the admin inventing a temporary one and sending it over some side channel
  // that then has to be trusted to be cleaned up.
  const handleResetLink = async (target) => {
    try {
      setResetting(true);
      const inv = await getClient().invites.create({ targetUserId: target.id });
      setResetCode(inv.code);
    } catch (err) {
      console.error('Error creating reset link:', err);
      notifyError(humanizeError(err, 'Failed to create a password reset link'));
    } finally {
      setResetting(false);
    }
  };

  // One route component serves every project id, so walking from A to B starts
  // a second read without ending the first and A can answer last, putting A's
  // member table and A's roles under B's heading.
  const begin = useLatestCall();

  const fetchProject = async () => {
    const isCurrent = begin();
    try {
      setLoading(true);
      const client = getClient();
      const projectData = await client.projects.get(projectId);
      if (!isCurrent()) return null;
      setProject(projectData);
      return projectData;
    } catch (err) {
      if (!isCurrent()) return null;
      console.error('Error fetching project:', err);
      notifyError('Failed to load project data');
      return null;
    } finally {
      if (isCurrent()) setLoading(false);
    }
  };

  // Once per project. `fetchProject` is redefined every render, so naming it
  // here would refetch on every render.
  useEffect(() => {
    fetchProject();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  // Search the directory (server-side ?q=). Runs once the box is touched, so an
  // empty query browses everyone (first page); typing filters. Members already
  // on the project are dropped from the results.
  useEffect(() => {
    if (!searchActive) return;
    let cancelled = false;
    (async () => {
      setSearchLoading(true);
      const client = getClient();
      try {
        const page = await client.users.listPage({
          q: debouncedSearch || undefined,
          limit: SEARCH_LIMIT,
        });
        const memberIds = new Set(aclMemberIds(project));
        const results = (page.entries || []).filter((u) => !memberIds.has(u.id));
        // A cursor back means the directory had more than the cap allowed.
        // Read it rather than counting results: members are filtered out
        // above, so a capped page can come back short.
        if (!cancelled) {
          setSearchResults(results);
          setSearchCapped(Boolean(page.nextCursor));
        }
      } catch (err) {
        console.error('User search failed:', err);
        if (!cancelled) {
          setSearchResults([]);
          setSearchCapped(false);
        }
      } finally {
        if (!cancelled) setSearchLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [debouncedSearch, searchActive, project, getClient]);

  const grant = (userId, newRole) =>
    setProjectRoleReporting({
      client: getClient(),
      project,
      projectId,
      userId,
      newRole,
      currentUserId: user?.id,
      onDataUpdate: fetchProject,
    });

  // Handle user creation
  const handleCreateUser = async (e) => {
    e.preventDefault();
    setCreateUserError('');
    setCreateUserLoading(true);

    if (!isEmail(newUserForm.email)) {
      setCreateUserError(EMAIL_INVALID_MESSAGE);
      setCreateUserLoading(false);
      return;
    }

    if (newUserForm.password !== newUserForm.confirmPassword) {
      setCreateUserError('Passwords do not match.');
      setCreateUserLoading(false);
      return;
    }

    if (newUserForm.password.length < 6) {
      setCreateUserError('Password must be at least 6 characters.');
      setCreateUserLoading(false);
      return;
    }

    try {
      const client = getClient();
      // The email becomes the account's id and login, permanently. A blank
      // display name lets the server default it to the email's local part.
      await client.users.create(
        newUserForm.email,
        newUserForm.password,
        newUserForm.isAdmin,
        newUserForm.displayName.trim() || undefined,
      );

      notifySuccess('User created');
      setShowCreateUserForm(false);
      setNewUserForm(EMPTY_USER_FORM);
      setCreateUserError('');
    } catch (err) {
      console.error('Error creating user:', err);
      if (err.status === 409 || (err.message && err.message.includes('409'))) {
        setCreateUserError(`An account for "${newUserForm.email}" already exists.`);
      } else {
        setCreateUserError(`Failed to create user: ${humanizeError(err)}`);
      }
    } finally {
      setCreateUserLoading(false);
    }
  };

  // Handle user editing
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
      setEditUserError('Enter a display name.');
      return;
    }

    if (editUserForm.password && editUserForm.password !== editUserForm.confirmPassword) {
      setEditUserError('Passwords do not match.');
      return;
    }

    if (editUserForm.password && editUserForm.password.length < 6) {
      setEditUserError('Password must be at least 6 characters.');
      return;
    }

    try {
      const client = getClient();
      const newDisplayName =
        editUserForm.displayName !== editingUser.displayName ? editUserForm.displayName : undefined;
      const newPassword = editUserForm.password || undefined;
      const newIsAdmin =
        editUserForm.isAdmin !== (editingUser.isAdmin || false) ? editUserForm.isAdmin : undefined;

      await client.users.update(editingUser.id, newPassword, newDisplayName, newIsAdmin);

      notifySuccess('User updated');
      setEditingUser(null);
      setEditUserForm(EMPTY_USER_FORM);
      await fetchProject();
    } catch (err) {
      console.error('Error updating user:', err);
      setEditUserError(`Failed to update user: ${humanizeError(err)}`);
    }
  };

  const handleDeleteUser = async () => {
    const target = editingUser;
    const ok = await confirm({
      title: `Delete ${target.displayName}`,
      description: 'This cannot be undone.',
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!ok) return;
    try {
      await getClient().users.delete(target.id);
      notifySuccess('User deleted');
      setEditingUser(null);
      await fetchProject();
    } catch (err) {
      console.error('Error deleting user:', err);
      notifyError(humanizeError(err), 'Failed to delete user');
    }
  };

  if (loading) {
    return <p className="p-4 text-sm text-muted-foreground">Loading…</p>;
  }

  const denied = (message) => (
    <div>
      <div
        role="alert"
        className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
      >
        {message}
      </div>
    </div>
  );

  if (!project) return denied('Project not found');
  if (!canManageProject(project, user))
    return denied('You do not have permission to manage this project.');

  const userCell = (u) => (
    <div className="flex min-w-0 items-center gap-2">
      <UserAvatar
        client={getClient()}
        userId={u.id}
        displayName={u.displayName}
        avatarHash={u.avatarHash}
        className="h-7 w-7"
      />
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{u.displayName}</span>
          {u.isAdmin && <Badge variant="secondary">Admin</Badge>}
        </div>
        <span className="block truncate text-xs text-muted-foreground">{u.id}</span>
      </div>
    </div>
  );

  return (
    <div className="flex flex-col gap-6">
      {isAdmin && (
        <div>
          <Button
            onClick={() => {
              setShowCreateUserForm(true);
              setCreateUserError('');
            }}
          >
            <Plus className="h-4 w-4" /> Create user
          </Button>
        </div>
      )}

      <ProjectMembers
        project={project}
        projectId={projectId}
        client={getClient()}
        currentUser={user}
        onDataUpdate={fetchProject}
        roleOptions={PERMISSION_OPTIONS}
        renderActions={
          isAdmin
            ? (m) => (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      aria-label="User actions"
                    >
                      <MoreVertical className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => startEditingUser(m)}>
                      Edit user
                    </DropdownMenuItem>
                    <DropdownMenuItem disabled={resetting} onClick={() => handleResetLink(m)}>
                      Create password reset link
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )
            : null
        }
      />

      <ProjectInvites
        projectId={projectId}
        projectName={project?.name}
        client={getClient()}
        canManage={canInvite}
        roleHints={ROLE_HINTS}
      />

      <MintedLinkDialog
        code={resetCode}
        onClose={() => setResetCode(null)}
        title="Password reset link created"
      />

      {/* Add a user (server-side search) */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Add a user</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <SearchInput
            placeholder="Search users by name…"
            value={search}
            onChange={setSearch}
            onFocus={() => setSearchActive(true)}
          />
          {searchActive &&
            (searchLoading ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : searchResults.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {debouncedSearch ? 'No matching users.' : 'No other users to add.'}
              </p>
            ) : (
              <div className="flex flex-col">
                {searchResults.map((u, i) => (
                  <div
                    key={u.id}
                    className={`flex items-center justify-between gap-2 py-2 ${i ? 'border-t' : ''}`}
                  >
                    {userCell(u)}
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="outline" size="sm">
                          <Plus className="h-3.5 w-3.5" /> Add
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuLabel>Add as</DropdownMenuLabel>
                        {GRANT_ROLES.map((role) => (
                          <DropdownMenuItem key={role} onClick={() => grant(u.id, role)}>
                            {role.charAt(0).toUpperCase() + role.slice(1)}
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                ))}
              </div>
            ))}
          {/* Outside the branch above: a capped search whose whole page was
              filtered out as existing members shows the empty message, and
              that is the case most in need of saying the list was cut. */}
          {searchActive && !searchLoading && searchCapped && (
            <ListHint>
              Showing the first {SEARCH_LIMIT} matches. Narrow the search to see others.
            </ListHint>
          )}
        </CardContent>
      </Card>

      {/* Create user */}
      <Dialog
        open={isAdmin && showCreateUserForm}
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
            {createUserError && (
              <div
                role="alert"
                className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              >
                {createUserError}
              </div>
            )}

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="pm-new-email">Email address</Label>
              <Input
                id="pm-new-email"
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
              <Label htmlFor="pm-new-display-name">Display name</Label>
              <Input
                id="pm-new-display-name"
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

            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="h-4 w-4 cursor-pointer accent-primary"
                checked={newUserForm.isAdmin}
                onChange={(e) => setNewUserForm((prev) => ({ ...prev, isAdmin: e.target.checked }))}
              />
              Admin
            </label>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="pm-new-password">Password</Label>
              <Input
                id="pm-new-password"
                type="password"
                value={newUserForm.password}
                onChange={(e) => setNewUserForm((prev) => ({ ...prev, password: e.target.value }))}
                autoComplete="new-password"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="pm-new-password-confirm">Confirm password</Label>
              <Input
                id="pm-new-password-confirm"
                type="password"
                value={newUserForm.confirmPassword}
                onChange={(e) =>
                  setNewUserForm((prev) => ({ ...prev, confirmPassword: e.target.value }))
                }
                autoComplete="new-password"
              />
            </div>

            <div className="flex justify-end">
              <Button type="submit" disabled={createUserLoading}>
                {createUserLoading ? 'Creating…' : 'Create user'}
              </Button>
            </div>
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
              {editUserError && (
                <div
                  role="alert"
                  className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                >
                  {editUserError}
                </div>
              )}

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="pm-edit-email">Email address</Label>
                <Input id="pm-edit-email" value={editUserForm.email} disabled readOnly />
                <p className="text-xs text-muted-foreground">
                  Fixed for the life of the account. It is what they sign in with.
                </p>
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="pm-edit-display-name">Display name</Label>
                <Input
                  id="pm-edit-display-name"
                  value={editUserForm.displayName}
                  onChange={(e) =>
                    setEditUserForm((prev) => ({ ...prev, displayName: e.target.value }))
                  }
                  autoFocus
                />
              </div>

              <label className="flex cursor-pointer items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="h-4 w-4 cursor-pointer accent-primary"
                  checked={editUserForm.isAdmin}
                  onChange={(e) =>
                    setEditUserForm((prev) => ({ ...prev, isAdmin: e.target.checked }))
                  }
                />
                Admin
              </label>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="pm-edit-password">New password</Label>
                <Input
                  id="pm-edit-password"
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
                <Label htmlFor="pm-edit-password-confirm">Confirm new password</Label>
                <Input
                  id="pm-edit-password-confirm"
                  type="password"
                  value={editUserForm.confirmPassword}
                  onChange={(e) =>
                    setEditUserForm((prev) => ({ ...prev, confirmPassword: e.target.value }))
                  }
                  autoComplete="new-password"
                />
              </div>

              <div className="flex items-center justify-between gap-2 pt-1">
                <Button
                  type="button"
                  variant="ghost"
                  className="text-destructive"
                  onClick={handleDeleteUser}
                  disabled={editingUser.id === user.id}
                  title={
                    editingUser.id === user.id ? 'You cannot delete your own account.' : undefined
                  }
                >
                  Delete user
                </Button>
                <div className="flex gap-2">
                  <Button type="button" variant="outline" onClick={() => setEditingUser(null)}>
                    Cancel
                  </Button>
                  <Button type="submit">Update user</Button>
                </div>
              </div>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
};
