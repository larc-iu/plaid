import { notifications } from '@mantine/notifications';

/**
 * Custom hook for handling strict mode 409 conflicts in document operations.
 * 
 * @param {Function} onDocumentReload - Callback to reload document data when a 409 conflict occurs
 * @returns {Function} handleError - Function to handle operation errors with 409 conflict detection
 */
export const useStrictModeErrorHandler = (onDocumentReload) => {
  const handleError = (error, operation = 'operation') => {
    console.error(`Failed to perform ${operation}:`, error);
    
    // Check if this is a 409 conflict due to concurrent modifications
    if (error.status === 409 || error.code === 409) {
      notifications.show({
        title: 'Document modified by another user',
        message: 'The document has been modified by another user. The view will be refreshed with the latest changes.',
        color: 'orange',
        autoClose: 5000
      });
      
      // Trigger document reload to get the latest state
      if (onDocumentReload) {
        onDocumentReload();
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