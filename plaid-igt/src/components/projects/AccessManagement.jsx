import { UserPlus, Plus, MoreVertical } from 'lucide-react';
import { Button } from '@ui/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
} from '@ui/components/ui/dropdown-menu';
import { ProjectInvites } from '@ui/components/shared/ProjectInvites.jsx';
import { ProjectMembers } from '@ui/components/shared/ProjectMembers.jsx';
import { aclMemberIds, setProjectRoleReporting } from '@ui/domain/projectRoles.js';
import { useUserAdmin } from '../admin/useUserAdmin';
import { UserAdminDialogs } from '../admin/userAdmin';
import { useUserSearch } from '@/hooks/useUserSearch';
import { UserSearch } from '@/components/shared/UserSearch';
import { MAINTAINER_HINT, NO_ACCESS_HINT, canManageProject } from '@ui/domain/permissions.js';

// Mirrors plaid-ud's ProjectManagement. The full user roster isn't fetched
// (doesn't scale + is admin-gated); instead "Members" come from the project's
// ACL and new grants come from a server-side `?q=` search.
// What each level grants, said where the choice is made. This screen decides
// what a class of fifteen can do and named the levels and nothing else, so the
// only way to learn that a Reader cannot leave a comment was to give someone
// Reader access and hear about it from them.
const ROLE_OPTIONS = [
  { value: 'none', label: 'No access', hint: NO_ACCESS_HINT },
  { value: 'reader', label: 'Reader', hint: 'Reads the texts and the lexicon. Cannot comment.' },
  { value: 'writer', label: 'Writer', hint: 'Also edits documents and links vocabulary.' },
  { value: 'maintainer', label: 'Maintainer', hint: MAINTAINER_HINT },
];
const GRANT_ROLES = ['reader', 'writer', 'maintainer'];

// The same lines under the invite screen's role picker: it is the other place
// the choice is made, and it is made for people who have no account yet.
const ROLE_HINTS = Object.fromEntries(
  ROLE_OPTIONS.filter((o) => o.value !== 'none').map((o) => [o.value, o.hint]),
);

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

export const AccessManagement = ({ project, user, projectId, client, onDataUpdate }) => {
  const isAdmin = !!user?.isAdmin;

  // Account administration (create, edit, deactivate, reset link) is shared
  // with the admin panel's Users tab.
  const userAdmin = useUserAdmin({ client, currentUser: user, onChanged: onDataUpdate });
  const { startEdit, createResetLink, resetting } = userAdmin;

  // Whether this user can hand out project invites. Maintainers can, which is
  // the point: onboarding a class should not queue behind an admin.
  const canInvite = canManageProject(project, user);

  const search = useUserSearch({ client, excludeIds: aclMemberIds(project) });

  const grant = (userId, newRole) =>
    setProjectRoleReporting({
      client,
      project,
      projectId,
      userId,
      newRole,
      currentUserId: user?.id,
      onDataUpdate,
    });

  return (
    <div className="flex flex-col gap-6 pt-4 [&>*+*]:border-t [&>*+*]:pt-6">
      <ProjectMembers
        project={project}
        projectId={projectId}
        client={client}
        currentUser={user}
        onDataUpdate={onDataUpdate}
        roleOptions={ROLE_OPTIONS}
        headerAction={
          isAdmin && (
            <Button size="sm" onClick={userAdmin.openCreate}>
              <UserPlus className="h-4 w-4" /> Create User
            </Button>
          )
        }
        renderActions={
          isAdmin
            ? (m) => (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      aria-label="User actions"
                    >
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
              )
            : null
        }
      />

      <ProjectInvites
        projectId={projectId}
        projectName={project?.name}
        client={client}
        canManage={canInvite}
        roleHints={ROLE_HINTS}
      />

      {/* Add a user (server-side search) */}
      <div>
        <div className="pb-3">
          <h2 className="text-lg font-semibold">Add a user</h2>
        </div>
        <UserSearch
          client={client}
          search={search}
          renderAction={(u) => (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="outline">
                  <Plus className="h-4 w-4" /> Add
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel>Add as…</DropdownMenuLabel>
                {GRANT_ROLES.map((role) => (
                  <DropdownMenuItem key={role} onSelect={() => grant(u.id, role)}>
                    {cap(role)}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        />
      </div>

      {/* Create User dialog */}
      <UserAdminDialogs controller={userAdmin} />
    </div>
  );
};
