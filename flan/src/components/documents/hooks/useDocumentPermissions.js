import { useAuth } from '../../../contexts/AuthContext.jsx';
import { useSnapshot } from 'valtio';
import documentsStore from '../../../stores/documentsStore.js';

export const useDocumentPermissions = (projectId, documentId) => {
  const { user } = useAuth();
  const storeSnap = useSnapshot(documentsStore);
  const projectData = storeSnap?.[projectId]?.[documentId]?.project;

  if (!user || !projectData) {
    return {
      canRead: false,
      canWrite: false,
      canManage: false,
      isReadOnly: true
    };
  }
  
  const userId = user.id;
  const isAdmin = user.isAdmin;
  
  // Admin has all permissions
  if (isAdmin) {
    return {
      canRead: true,
      canWrite: true,
      canManage: true,
      isReadOnly: false
    };
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
  
  return {
    canRead,
    canWrite,
    canManage,
    isReadOnly
  };
};