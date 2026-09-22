import { projectRole } from '@larc-iu/plaid-client';
import { notifySuccess, notifyError } from '../lib/notify.js';
import { MAINTAINER_HINT, NO_ACCESS_HINT } from './permissions.js';

// The project ACL as the Access screens work with it. It toasts, so it belongs
// to the screens rather than to a domain layer a node suite loads directly: see
// plaid-ud's note about `@ui` imports from its own `domain/`.

// Most access first, so a Project role column groups the way someone scanning
// it expects rather than alphabetically.
export const ROLE_RANK = { maintainer: 0, writer: 1, reader: 2, none: 3 };

// The three a link or a search result can be granted, in the order a picker
// offers them: no way to take access away, because there is nothing to take.
export const GRANT_ROLES = ['reader', 'writer', 'maintainer'];

/**
 * What each role grants, in the words of the app asking, for every screen that
 * offers the choice: the members table, the invitation links, the search
 * results, and plaid-igt's batch of links.
 *
 * Written once because a reader of one of those screens and a reader of another
 * are being told about the same four grants, and because naming the levels and
 * nothing else left "a Reader cannot comment" to be learned by granting someone
 * Reader and hearing about it. Two of the four lines name what the app holds
 * (texts and a lexicon, a treebank, meaning representations), so the app hands
 * those two over and the other two read the same everywhere.
 */
export const projectRoleOptions = ({ readerHint, writerHint }) => [
  { value: 'none', label: 'No access', hint: NO_ACCESS_HINT },
  { value: 'reader', label: 'Reader', hint: readerHint },
  { value: 'writer', label: 'Writer', hint: writerHint },
  { value: 'maintainer', label: 'Maintainer', hint: MAINTAINER_HINT },
];

/** The same hints by role, for the pickers that cannot offer 'none'. */
export const grantRoleHints = (roleOptions) =>
  Object.fromEntries(roleOptions.filter((o) => o.value !== 'none').map((o) => [o.value, o.hint]));

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
