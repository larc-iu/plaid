import { Text } from '@mantine/core';
import { modals } from '@mantine/modals';

// App-wide feedback primitives. Transient outcomes are toasts; destructive
// actions go through a confirm modal (replacing the old window.confirm()).
// The toast functions live in notify.js (JSX-free, importable from node);
// re-exported here so components keep one import site.
export { notifySuccess, notifyError, notifyWarning } from './notify.js';

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
