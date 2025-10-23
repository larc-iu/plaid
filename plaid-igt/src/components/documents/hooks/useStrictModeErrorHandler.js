import { notifications } from '@mantine/notifications';

/**
 * Custom hook for handling strict mode 409 conflicts in document operations.
 * 
 * @param {Function} documentReload - Callback to reload document data when a 409 conflict occurs
 * @returns {Function} handleError - Function to handle operation errors with 409 conflict detection
 */
export const useStrictModeErrorHandler = (documentReload) => {
  const handleError = (error, operation = 'operation') => {
    console.error(`Failed to perform ${operation}:`, error);
    
    // Check if this is a 409 conflict due to concurrent modifications
    // Also could be a 400 if user is trying to modify something that got deleted.
    if (error.status === 409
        || (error.status === 400 && error?.responseData?.error.startsWith("document-version was provided but"))) {
      notifications.show({
        title: 'Document modified by another user',
        message: 'Another user made a change in this document, and it will be refreshed with the latest changes.',
        color: 'orange',
        autoClose: 5000
      });
      
      // Trigger document reload to get the latest state
      if (documentReload) {
        documentReload();
      }
    } else {
      // For other errors, show a generic error message
      notifications.show({
        title: 'Operation failed',
        message: `Failed to ${operation}. Please try again.`,
        color: 'red'
      });
    }
  };
  
  return handleError;
};