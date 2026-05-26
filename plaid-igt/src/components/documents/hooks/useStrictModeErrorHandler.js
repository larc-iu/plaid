import { notifications } from '@mantine/notifications';

/**
 * Custom hook for handling strict mode 409 conflicts in document operations.
 *
 * @param {Function} documentReload - Callback to reload document data when a 409 conflict occurs
 * @returns {Function} handleError - Function to handle operation errors with 409 conflict detection
 *
 * The returned handleError accepts an optional options object:
 *   handleError(error, operation, { rollback: true })
 *
 * When `rollback` is true, the handler always triggers `documentReload` after showing the
 * error notification — use this for operations that mutated valtio state optimistically
 * before calling the server. Without `rollback`, reload only fires on 409 (and the 400
 * "document-version" variant) per the original strict-mode behavior.
 */
export const useStrictModeErrorHandler = (documentReload) => {
  const handleError = (error, operation = 'operation', options = {}) => {
    const { rollback = false } = options;
    console.error(`Failed to perform ${operation}:`, error);

    // Check if this is a 409 conflict due to concurrent modifications
    // Also could be a 400 if user is trying to modify something that got deleted.
    const isConflict = error.status === 409
      || (error.status === 400 && error?.responseData?.error?.startsWith?.("document-version was provided but"));

    if (isConflict) {
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

      // If the operation already mutated local state optimistically, force a reload so
      // the UI re-syncs with the server's actual state.
      if (rollback && documentReload) {
        documentReload();
      }
    }
  };

  return handleError;
};