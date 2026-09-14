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
import { canManageProject } from '@ui/domain/permissions.js';
import { ROLE_HINTS, ROLE_OPTIONS } from '@/domain/roleGrants.js';

// Mirrors plaid-ud's ProjectManagement. The full user roster isn't fetched
// (doesn't scale + is admin-gated); instead "Members" come from the project's
// ACL and new grants come from a server-side `?q=` search.
const GRANT_ROLES = ['reader', 'writer', 'maintainer'];

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
