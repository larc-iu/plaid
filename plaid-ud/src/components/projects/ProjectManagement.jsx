import { useState, useEffect, useRef } from 'react';
import { useParams } from 'react-router-dom';
import { useDebouncedValue } from '@mantine/hooks';
import { MoreVertical, Plus } from 'lucide-react';
import {
  PLAID_NAMESPACE,
  REVIEW_KEY,
  isReviewed,
  projectRole,
  readReview,
  withReviewedUser,
} from '@larc-iu/plaid-client';
import { ProjectInvites, MintedLinkModal } from './ProjectInvites';
import { useAuth } from '../../contexts/AuthContext';
import { notifySuccess, notifyError } from '../../utils/feedback.jsx';
import { useConfirm } from '@ui/components/shared/ConfirmProvider';
import { canManageProject } from '../../utils/permissions.js';
import { isEmail, EMAIL_INVALID_MESSAGE } from '../../utils/email';
import { UserAvatar } from '@ui/components/shared/UserAvatar';
import { Badge } from '@ui/components/ui/badge';
import { Button } from '@ui/components/ui/button';
import { Input } from '@ui/components/ui/input';
import { Label } from '@ui/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@ui/components/ui/card';
import { SearchInput, ListHint } from '@ui/components/ui/list-search';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@ui/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@ui/components/ui/dropdown-menu';

const PERMISSION_OPTIONS = [
  { value: 'none', label: 'None' },
  { value: 'reader', label: 'Reader' },
  { value: 'writer', label: 'Writer' },
  { value: 'maintainer', label: 'Maintainer' },
];
const GRANT_ROLES = ['reader', 'writer', 'maintainer'];
const SEARCH_LIMIT = 25;

const EMPTY_USER_FORM = {
  email: '',
  displayName: '',
  password: '',
  confirmPassword: '',
  isAdmin: false,
};

// Role a given user holds on a project, from the project's ACL arrays.
const roleOf = (project, userId) => {
  if (project?.maintainers?.includes(userId)) return 'maintainer';
  if (project?.writers?.includes(userId)) return 'writer';
  if (project?.readers?.includes(userId)) return 'reader';
  return 'none';
};

export const ProjectManagement = () => {
  const { projectId } = useParams();
  const { user, getClient } = useAuth();
  const confirm = useConfirm();
  const [project, setProject] = useState(null);
  const [loading, setLoading] = useState(true);

  // Project members (users with a role here), resolved from the ACL — admins
  // excluded (they reach everything implicitly, so they're not "members").
  const [members, setMembers] = useState([]);
  const [membersLoading, setMembersLoading] = useState(true);

  // Search-to-add. The roster isn't fetched wholesale; we query the server.
  const [search, setSearch] = useState('');
  const [debouncedSearch] = useDebouncedValue(search, 250);
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
  // the point: onboarding a class should not queue behind an admin.
  const canInvite = isAdmin || (project?.maintainers || []).includes(user?.id);

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
      notifyError(err.message || 'Failed to create a password reset link');
    } finally {
      setResetting(false);
    }
  };

  const fetchProject = async () => {
    try {
      setLoading(true);
      const client = getClient();
      const projectData = await client.projects.get(projectId);
      setProject(projectData);
      return projectData;
    } catch (err) {
      console.error('Error fetching project:', err);
      notifyError('Failed to load project data');
      return null;
    } finally {
      setLoading(false);
    }
  };

  // Once per project. `fetchProject` is redefined every render, so naming it
  // here would refetch on every render.
  useEffect(() => {
    fetchProject();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  // Resolve the ACL member ids to user objects (for display names + admin flag).
  // The member set is project-sized, not instance-sized, so per-id GETs are fine.
  // Everyone here was EXPLICITLY granted a role — including admins who were
  // explicitly added (they get an "Admin" badge). Admins with only implicit
  // global access are never in the ACL arrays, so they don't show up.
  // Keyed on WHO is on the ACL, not on the project object: a refetch that
  // changed only config (the review mark) or the name must neither re-resolve
  // nor blank the table. Roles are read off the project at render (see
  // `rows`), so a role change shows the moment the project refreshes. The
  // spinner shows only before the first resolve; a later one (someone added
  // or removed) swaps the rows in place.
  const aclKey = [
    ...new Set([
      ...(project?.maintainers || []),
      ...(project?.writers || []),
      ...(project?.readers || []),
    ]),
  ].join('\n');
  const projectLoaded = !!project;
  const membersRef = useRef(members);
  membersRef.current = members;
  useEffect(() => {
    if (!projectLoaded) return;
    let cancelled = false;
    (async () => {
      if (membersRef.current.length === 0) setMembersLoading(true);
      const client = getClient();
      const ids = aclKey ? aclKey.split('\n') : [];
      try {
        const resolved = await Promise.all(
          ids.map((id) =>
            client.users.get(id).catch(() => ({ id, displayName: id, isAdmin: false })),
          ),
        );
        resolved.sort((a, b) => (a.displayName || '').localeCompare(b.displayName || ''));
        if (!cancelled) setMembers(resolved);
      } catch (err) {
        console.error('Error resolving members:', err);
        if (!cancelled) setMembers([]);
      } finally {
        if (!cancelled) setMembersLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [aclKey, projectLoaded, getClient]);
  const rows = members.map((m) => ({ ...m, role: roleOf(project, m.id) }));

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
        const memberIds = new Set(members.map((m) => m.id));
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
  }, [debouncedSearch, searchActive, members, getClient]);

  // Add / change / remove a project role for a user.
  const setRole = async (userId, newLevel) => {
    try {
      const client = getClient();
      const current = roleOf(project, userId);
      if (current === newLevel) return;

      if (current === 'maintainer') await client.projects.removeMaintainer(projectId, userId);
      else if (current === 'writer') await client.projects.removeWriter(projectId, userId);
      else if (current === 'reader') await client.projects.removeReader(projectId, userId);

      if (newLevel === 'maintainer') await client.projects.addMaintainer(projectId, userId);
      else if (newLevel === 'writer') await client.projects.addWriter(projectId, userId);
      else if (newLevel === 'reader') await client.projects.addReader(projectId, userId);

      notifySuccess('Permissions updated');
      await fetchProject(); // re-resolves members + refreshes search filter
    } catch (err) {
      console.error('Error updating permissions:', err);
      notifyError('Failed to update permissions');
    }
  };

  // Whose work is reviewed (the cross-app `plaid.review` norm, provenance
  // convention): a marked member's annotations are recorded as contributed
  // until a verifier confirms them. Independent of the role: any member can be
  // marked. A project may also mark whole roles (another app's setting); such
  // members show as reviewed and cannot be unmarked one by one here.
  // { id, on } while a toggle is in flight, so the box shows the new state
  // at once instead of snapping back until the project refreshes.
  const [updatingReview, setUpdatingReview] = useState(null);
  const reviewedByRole = (m) => {
    const { users, roles } = readReview(project?.config);
    return (
      !users.includes(m.id) && roles.includes(projectRole(project, m.id, { isAdmin: m.isAdmin }))
    );
  };
  const setReviewed = async (userId, on) => {
    try {
      setUpdatingReview({ id: userId, on });
      const client = getClient();
      const next = withReviewedUser(project?.config?.[PLAID_NAMESPACE]?.[REVIEW_KEY], userId, on);
      await client.projects.setConfig(projectId, PLAID_NAMESPACE, REVIEW_KEY, next);
      await fetchProject();
    } catch (err) {
      console.error('Error updating review:', err);
      notifyError('Failed to update review');
    } finally {
      setUpdatingReview(null);
    }
  };

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
      setCreateUserError('Passwords do not match');
      setCreateUserLoading(false);
      return;
    }

    if (newUserForm.password.length < 6) {
      setCreateUserError('Password must be at least 6 characters long');
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

      notifySuccess('User created successfully');
      setShowCreateUserForm(false);
      setNewUserForm(EMPTY_USER_FORM);
      setCreateUserError('');
    } catch (err) {
      console.error('Error creating user:', err);
      if (err.status === 409 || (err.message && err.message.includes('409'))) {
        setCreateUserError(`An account for "${newUserForm.email}" already exists.`);
      } else {
        setCreateUserError('Failed to create user: ' + (err.message || 'Unknown error'));
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
      setEditUserError('Enter a display name');
      return;
    }

    if (editUserForm.password && editUserForm.password !== editUserForm.confirmPassword) {
      setEditUserError('Passwords do not match');
      return;
    }

    if (editUserForm.password && editUserForm.password.length < 6) {
      setEditUserError('Password must be at least 6 characters long');
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

      notifySuccess('User updated successfully');
      setEditingUser(null);
      setEditUserForm(EMPTY_USER_FORM);
      await fetchProject();
    } catch (err) {
      console.error('Error updating user:', err);
      setEditUserError('Failed to update user: ' + (err.message || 'Unknown error'));
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
      notifySuccess('User deleted successfully');
      setEditingUser(null);
      await fetchProject();
    } catch (err) {
      console.error('Error deleting user:', err);
      notifyError('Failed to delete user: ' + (err.message || 'Unknown error'));
    }
  };

  if (loading) {
    return <p className="tw p-4 text-sm text-muted-foreground">Loading…</p>;
  }

  const denied = (message) => (
    <div className="tw">
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
    return denied('You do not have permission to manage this project');

  const userCell = (u) => (
    <>
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
        </span>
        <span className="block truncate text-xs text-muted-foreground">{u.id}</span>
      </span>
    </>
  );

  return (
    <div className="tw flex flex-col gap-6">
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

      {/* Current members */}
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="text-lg">Members</CardTitle>
          <span className="text-sm text-muted-foreground">{members.length} with access</span>
        </CardHeader>
        <CardContent>
          {membersLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : members.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No one has been granted access yet. Use “Add a user” below.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th className="py-2 pr-3 font-medium">User</th>
                    <th className="px-3 py-2 font-medium">Project role</th>
                    <th
                      className="px-3 py-2 font-medium"
                      title="Their annotations are marked as contributed until a verifier confirms them"
                    >
                      Review work
                    </th>
                    {isAdmin && <th className="w-12 py-2" />}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((m) => (
                    <tr key={m.id} className="border-b">
                      <td className="py-2 pr-3">
                        <div className="flex items-center gap-2">{userCell(m)}</div>
                      </td>
                      <td className="px-3 py-2">
                        <select
                          className="h-8 w-36 rounded-md border border-input bg-transparent px-2 text-sm disabled:cursor-not-allowed disabled:opacity-50"
                          value={m.role}
                          aria-label={`${m.displayName} project role`}
                          disabled={m.id === user.id}
                          onChange={(e) => setRole(m.id, e.target.value)}
                        >
                          {PERMISSION_OPTIONS.map((o) => (
                            <option key={o.value} value={o.value}>
                              {o.label}
                            </option>
                          ))}
                        </select>
                        {m.id === user.id && (
                          <p className="mt-0.5 text-xs text-muted-foreground">Your own access</p>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <input
                          type="checkbox"
                          className="h-4 w-4 cursor-pointer accent-primary disabled:cursor-not-allowed"
                          aria-label={`Review ${m.displayName}'s work`}
                          checked={
                            updatingReview?.id === m.id
                              ? updatingReview.on
                              : isReviewed(project, m.id, { isAdmin: m.isAdmin })
                          }
                          disabled={updatingReview?.id === m.id || reviewedByRole(m)}
                          title={
                            reviewedByRole(m)
                              ? `Every ${projectRole(project, m.id, { isAdmin: m.isAdmin })} is reviewed in this project`
                              : undefined
                          }
                          onChange={(e) => setReviewed(m.id, e.target.checked)}
                        />
                      </td>
                      {isAdmin && (
                        <td className="py-2">
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
                              <DropdownMenuItem
                                disabled={resetting}
                                onClick={() => handleResetLink(m)}
                              >
                                Create password reset link
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <ProjectInvites
        projectId={projectId}
        projectName={project?.name}
        client={getClient()}
        canManage={canInvite}
      />

      <MintedLinkModal
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
                    <div className="flex min-w-0 items-center gap-2">{userCell(u)}</div>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="outline" size="sm">
                          <Plus className="h-3.5 w-3.5" /> Add
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuLabel>Add as</DropdownMenuLabel>
                        {GRANT_ROLES.map((role) => (
                          <DropdownMenuItem key={role} onClick={() => setRole(u.id, role)}>
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
                    editingUser.id === user.id ? 'You cannot delete your own account' : undefined
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
