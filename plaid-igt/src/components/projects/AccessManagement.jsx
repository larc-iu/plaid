import { useState, useEffect, useRef } from 'react';
import { UserPlus, Plus, MoreVertical } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SearchInput, ListHint } from '@/components/ui/list-search';
import { DataTable } from '@/components/ui/data-table';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { UserAvatar } from '@/components/shared/UserAvatar';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
} from '@/components/ui/dropdown-menu';
import { notifySuccess, notifyError } from '@/utils/feedback';
import { ProjectInvites } from './ProjectInvites';
import { useUserAdmin, UserAdminDialogs } from '../admin/userAdmin';
import {
  PLAID_NAMESPACE,
  REVIEW_KEY,
  isReviewed,
  projectRole,
  readReview,
  withReviewedUser,
} from '@larc-iu/plaid-client';

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
// Most access first, so the Project role column groups the way someone
// scanning it expects rather than alphabetically.
const ROLE_RANK = { maintainer: 0, writer: 1, reader: 2, none: 3 };

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
  const [searchCapped, setSearchCapped] = useState(false);
  const [searchLoading, setSearchLoading] = useState(false);

  // Account administration (create, edit, deactivate, reset link) is shared
  // with the admin panel's Users tab.
  const userAdmin = useUserAdmin({ client, currentUser: user, onChanged: onDataUpdate });
  const { startEdit, createResetLink, resetting } = userAdmin;

  // Whether this user can hand out project invites. Maintainers can, which is
  // the point: onboarding a class should not queue behind an admin.
  const canInvite = isAdmin || (project?.maintainers || []).includes(user?.id);

  // Whose work is reviewed (the cross-app `plaid.review` norm, provenance
  // convention): a marked member's annotations are recorded as contributed
  // until a verifier confirms them. Independent of the role: any member can
  // be marked. A project may also mark whole roles (another app's setting);
  // such members show as reviewed and cannot be unmarked one by one here.
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
      const next = withReviewedUser(project?.config?.[PLAID_NAMESPACE]?.[REVIEW_KEY], userId, on);
      await client.projects.setConfig(projectId, PLAID_NAMESPACE, REVIEW_KEY, next);
      await onDataUpdate();
    } catch (err) {
      console.error('Error updating review:', err);
      notifyError('Failed to update review. Please try again.', 'Error');
    } finally {
      setUpdatingReview(null);
    }
  };

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 250);
    return () => clearTimeout(t);
  }, [search]);

  // Resolve ACL member ids to user objects (project-sized, so per-id GETs are
  // fine). Keyed on WHO is on the ACL, not on the project object: a refetch
  // that changed only config (the review mark) or the name must neither
  // re-resolve nor blank the table. Roles are read off the project at render
  // (see `rows`), so a role change shows the moment the project refreshes.
  // The spinner shows only before the first resolve; a later one (someone
  // added or removed) swaps the rows in place.
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
  }, [aclKey, projectLoaded, client]);
  const rows = members.map((m) => ({ ...m, role: roleOf(project, m.id) }));

  // Server-side search (?q=). Runs once the box is touched; empty browses the
  // first page. Members already on the project are dropped.
  useEffect(() => {
    if (!searchActive) return;
    let cancelled = false;
    (async () => {
      setSearchLoading(true);
      try {
        const page = await client.users.listPage({
          q: debouncedSearch || undefined,
          limit: SEARCH_LIMIT,
        });
        const entries = page.entries || [];
        const memberIds = new Set(members.map((m) => m.id));
        const results = entries.filter((u) => !memberIds.has(u.id));
        if (!cancelled) {
          setSearchResults(results);
          // Measured before members are dropped: that filter is why the rows on
          // screen can number fewer than the page the server actually sent.
          setSearchCapped(entries.length >= SEARCH_LIMIT);
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

  const memberColumns = [
    {
      key: 'user',
      label: 'User',
      sort: (m) => (m.displayName || '').toLowerCase(),
      render: (m) => (
        <div className="flex items-center gap-2">
          <UserAvatar
            client={client}
            userId={m.id}
            displayName={m.displayName}
            avatarHash={m.avatarHash}
            className="h-7 w-7"
          />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-medium">{m.displayName}</span>
              {m.isAdmin && <Badge variant="secondary">Admin</Badge>}
            </div>
            <span className="text-xs text-muted-foreground">{m.id}</span>
          </div>
        </div>
      ),
    },
    {
      key: 'role',
      label: 'Project role',
      sort: (m) => ROLE_RANK[m.role] ?? ROLE_RANK.none,
      render: (m) => (
        <Select
          value={m.role}
          onValueChange={(v) => setRole(m.id, v)}
          disabled={m.id === user.id || updatingUser === m.id}
        >
          <SelectTrigger className="h-8 w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ROLE_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ),
    },
    {
      key: 'review',
      label: (
        <span title="Their annotations are marked as contributed until a maintainer confirms them">
          Review work
        </span>
      ),
      // The stored mark, not the box: a toggle in flight would otherwise move
      // the row out from under the click that made it.
      sort: (m) => (isReviewed(project, m.id, { isAdmin: m.isAdmin }) ? 0 : 1),
      render: (m) => (
        <input
          type="checkbox"
          className="h-4 w-4"
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
      ),
    },
    ...(isAdmin
      ? [
          {
            key: 'actions',
            label: '',
            headerClassName: 'w-12',
            render: (m) => (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="User actions">
                    <MoreVertical className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={() => startEdit(m)}>Edit user…</DropdownMenuItem>
                  <DropdownMenuItem disabled={resetting} onSelect={() => createResetLink(m)}>
                    Create password reset link…
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ),
          },
        ]
      : []),
  ];

  return (
    <div className="tw flex flex-col gap-6 pt-4 [&>*+*]:border-t [&>*+*]:pt-6">
      {/* Members */}
      <div>
        <div className="flex items-center justify-between gap-2 pb-3">
          <h2 className="text-lg font-semibold">Members</h2>
          {isAdmin && (
            <Button size="sm" onClick={userAdmin.openCreate}>
              <UserPlus className="h-4 w-4" /> Create User
            </Button>
          )}
        </div>

        {membersLoading ? (
          <div className="flex justify-center py-8 text-muted-foreground">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-muted border-t-primary" />
          </div>
        ) : (
          <DataTable
            rows={rows}
            columns={memberColumns}
            rowKey={(m) => m.id}
            id="project-members"
            scope={projectId}
            defaultSort={{ key: 'user', dir: 'asc' }}
            noun="member"
            empty="No one has been granted access yet. Use “Add a user” below."
          />
        )}
      </div>

      <ProjectInvites
        projectId={projectId}
        projectName={project?.name}
        client={client}
        canManage={canInvite}
      />

      {/* Add a user (server-side search) */}
      <div>
        <div className="pb-3">
          <h2 className="text-lg font-semibold">Add a user</h2>
        </div>
        <div className="flex flex-col gap-2">
          <SearchInput
            placeholder="Search users by name…"
            value={search}
            onChange={setSearch}
            onFocus={() => setSearchActive(true)}
          />

          {searchActive &&
            (searchLoading ? (
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
                    <div className="flex min-w-0 items-center gap-2">
                      <UserAvatar
                        client={client}
                        userId={u.id}
                        displayName={u.displayName}
                        avatarHash={u.avatarHash}
                        className="h-7 w-7"
                      />
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="truncate font-medium">{u.displayName}</span>
                          {u.isAdmin && <Badge variant="secondary">Admin</Badge>}
                        </div>
                        <span className="block truncate text-xs text-muted-foreground">{u.id}</span>
                      </div>
                    </div>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button size="sm" variant="outline">
                          <Plus className="h-4 w-4" /> Add
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuLabel>Add as…</DropdownMenuLabel>
                        {GRANT_ROLES.map((role) => (
                          <DropdownMenuItem key={role} onSelect={() => setRole(u.id, role)}>
                            {cap(role)}
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                ))}
                {searchCapped && (
                  <ListHint className="pt-2">
                    Showing the first {SEARCH_LIMIT} matches. Keep typing to narrow the list.
                  </ListHint>
                )}
              </div>
            ))}
        </div>
      </div>

      {/* Create User dialog */}
      <UserAdminDialogs controller={userAdmin} />
    </div>
  );
};
