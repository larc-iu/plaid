import { notifyError, notifySuccess } from '../../lib/notify.js';
import { setProjectRole } from '../../domain/projectRoles.js';

// The Access screens' half of a role change: what `setProjectRole` answers,
// said to the person.

/** `setProjectRole`, with what it answers said as a toast. */
export const setProjectRoleNotifying = async (args) => {
  const result = await setProjectRole(args);
  if (result.refused) notifyError(result.refused);
  else if (result.changed) notifySuccess('Permissions updated');
  return result;
};

/**
 * `setProjectRoleNotifying`, with its failure described rather than thrown. A
 * refused change says why, and the project is read again, since a role change
 * is a remove then an add and the remove may be the half that landed. A
 * refetch that fails after the change landed is not the change failing: it is
 * logged.
 */
export const setProjectRoleReporting = async (args) => {
  const refetch = async () => {
    try {
      await args.onDataUpdate();
    } catch (err) {
      console.error('Error refreshing the project:', err);
    }
  };
  try {
    await setProjectRoleNotifying({ ...args, onDataUpdate: refetch });
  } catch (err) {
    console.error('Error updating role:', err);
    notifyError(err, 'Failed to update permissions');
    await refetch();
  }
};
