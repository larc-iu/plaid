import { useAuth } from '../../../contexts/AuthContext.jsx';

// Derives the current user's permissions for a project. Takes the project object
// directly (from the shared IgtDocument) rather than reading a store.
export const useDocumentPermissions = (projectData) => {
  const { user } = useAuth();

  if (!user || !projectData) {
    return { canRead: false, canWrite: false, canManage: false, isReadOnly: true };
  }

  const userId = user.id;
  const isAdmin = user.isAdmin;

  // Admin has all permissions
  if (isAdmin) {
    return { canRead: true, canWrite: true, canManage: true, isReadOnly: false };
  }

  // Check specific project permissions
  const isReader = projectData.readers?.includes(userId) || false;
  const isWriter = projectData.writers?.includes(userId) || false;
  const isMaintainer = projectData.maintainers?.includes(userId) || false;

  // Higher permissions include lower ones
  const canManage = isMaintainer;
  const canWrite = isMaintainer || isWriter;
  const canRead = isMaintainer || isWriter || isReader;

  // Read-only if user can only read (not write or manage)
  const isReadOnly = canRead && !canWrite;

  return { canRead, canWrite, canManage, isReadOnly };
};
