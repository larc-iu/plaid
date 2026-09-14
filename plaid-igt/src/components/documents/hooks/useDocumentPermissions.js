import { canEditProject, canManageProject, canReadProject } from '@ui/domain/permissions.js';
import { useAuth } from '../../../contexts/AuthContext.jsx';

// The current user's permissions for a project, taken from the project object
// directly (the one on the shared IgtDocument) rather than from a store.
//
// What each level grants is `@ui/domain/permissions.js` and only there: this
// screen used to walk the three permission arrays itself, so the document
// editor could disagree with every other screen in the app.
export const useDocumentPermissions = (projectData) => {
  const { user } = useAuth();

  // Nothing is known until the project is. An admin passes every test in
  // `permissions.js` on the user alone, so without this the editor renders as
  // writable during the load and the first keystroke goes to a document whose
  // project has not arrived.
  if (!projectData) {
    return { canRead: false, canWrite: false, canManage: false, isReadOnly: true };
  }

  const canRead = canReadProject(projectData, user);
  const canWrite = canEditProject(projectData, user);
  const canManage = canManageProject(projectData, user);

  // A reader sees the document and cannot change it. Someone with no access at
  // all is read-only too, having nothing to edit.
  return { canRead, canWrite, canManage, isReadOnly: !canWrite };
};
