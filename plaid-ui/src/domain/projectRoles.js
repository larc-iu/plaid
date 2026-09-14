import { projectRole } from '@larc-iu/plaid-client';
import { notifySuccess, notifyError } from '../lib/notify.js';

// The project ACL as the Access screens work with it. It toasts, so it belongs
// to the screens rather than to a domain layer a node suite loads directly: see
// plaid-ud's note about `@ui` imports from its own `domain/`.

// Most access first, so a Project role column groups the way someone scanning
// it expects rather than alphabetically.
export const ROLE_RANK = { maintainer: 0, writer: 1, reader: 2, none: 3 };

/**
 * The role someone was explicitly granted, as these screens spell it: the
 * client says `null` for a non-member and a Select needs a value.
 */
export const roleOf = (project, userId) => projectRole(project, userId) ?? 'none';

/**
 * Everyone explicitly granted a role, from the project's own ACL. Admins with
 * only implicit access are not in these arrays and so are not members.
 */
export const aclMemberIds = (project) => [
  ...new Set([
    ...(project?.maintainers || []),
    ...(project?.writers || []),
    ...(project?.readers || []),
  ]),
];

/**
 * Move a user to `newRole` on a project, or off it with 'none'.
 *
 * The server has no single "set the role" call, so this is remove-then-add, and
 * both halves have to run in that order or a user briefly holds two roles.
 * Refuses to change the caller's own role: the Select is disabled on that row,
 * but the search-to-add menu is another way in and a guard belongs where every
 * path reaches it.
 */
export const setProjectRole = async ({
  client,
  project,
  projectId,
  userId,
  newRole,
  currentUserId,
  onDataUpdate,
}) => {
  if (userId === currentUserId) {
    notifyError('You cannot change your own role', 'Cannot modify own permissions');
    return;
  }
  const current = roleOf(project, userId);
  if (current === newRole) return;

  if (current === 'maintainer') await client.projects.removeMaintainer(projectId, userId);
  else if (current === 'writer') await client.projects.removeWriter(projectId, userId);
  else if (current === 'reader') await client.projects.removeReader(projectId, userId);

  if (newRole === 'maintainer') await client.projects.addMaintainer(projectId, userId);
  else if (newRole === 'writer') await client.projects.addWriter(projectId, userId);
  else if (newRole === 'reader') await client.projects.addReader(projectId, userId);

  await onDataUpdate(); // re-resolves the members
  notifySuccess('Permissions updated', 'Success');
};

/** `setProjectRole`, with its failure described rather than thrown. */
export const setProjectRoleReporting = async (args) => {
  try {
    await setProjectRole(args);
  } catch (err) {
    console.error('Error updating role:', err);
    notifyError('Failed to update permissions', 'Error');
  }
};
