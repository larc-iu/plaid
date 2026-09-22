import { UserPlus, Plus, MoreVertical } from 'lucide-react';
import { Button } from '../ui/button';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
} from '../ui/dropdown-menu';
import { ProjectInvites } from './ProjectInvites.jsx';
import { ProjectMembers } from './ProjectMembers.jsx';
import { UserAdminDialogs } from './UserAdminDialogs.jsx';
import { UserSearch } from './UserSearch.jsx';
import { useUserAdmin } from '../../hooks/useUserAdmin.js';
import { useUserSearch } from '../../hooks/useUserSearch.js';
import { canManageProject } from '../../domain/permissions.js';
import {
  GRANT_ROLES,
  aclMemberIds,
  grantRoleHints,
  setProjectRoleReporting,
} from '../../domain/projectRoles.js';

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Who is on a project, what they may do, and how somebody else gets on it: the
 * members table, the invitation links, a search over the user directory, and
 * the account administration an admin does from here.
 *
 * The one screen for every app. The full roster is never fetched (it does not
 * scale, and GET /users is admin-or-maintainer gated): members come from the
 * project's own ACL and new grants come from a server-side `?q=` search.
 *
 * `roleOptions` is the app's, because two of the four hints are written in its
 * own vocabulary (`domain/projectRoles.js` builds them from a noun).
 */
export const ProjectAccessScreen = ({
  project,
  projectId,
  client,
  user,
  onDataUpdate,
  roleOptions,
}) => {
  const isAdmin = !!user?.isAdmin;

  // Account administration (create, edit, deactivate, reset link) is shared
  // with plaid-igt's admin panel.
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
        roleOptions={roleOptions}
        headerAction={
          isAdmin && (
            <Button size="sm" onClick={userAdmin.openCreate}>
              <UserPlus className="h-4 w-4" /> Create user
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
        roleHints={grantRoleHints(roleOptions)}
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

      <UserAdminDialogs controller={userAdmin} />
    </div>
  );
};
