import { Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { modals } from '@mantine/modals';

// App-wide feedback primitives. Transient outcomes are toasts; destructive
// actions go through a confirm modal (replacing the old window.confirm()).

export const notifySuccess = (message, title) =>
  notifications.show({ title, message, color: 'green' });

export const notifyError = (message, title = 'Error') =>
  notifications.show({ title, message, color: 'red' });

export const confirmDelete = ({
  title = 'Confirm deletion',
  message,
  confirmLabel = 'Delete',
  onConfirm,
}) =>
  modals.openConfirmModal({
    title,
    children: <Text size="sm">{message}</Text>,
    labels: { confirm: confirmLabel, cancel: 'Cancel' },
    confirmProps: { color: 'red' },
    onConfirm,
  });
