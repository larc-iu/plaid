import { Button, Group, Text } from '@mantine/core';
import { modals } from '@mantine/modals';
import { notifications } from '@mantine/notifications';
import { randomId } from '@mantine/hooks';

// App-wide feedback primitives. Transient outcomes are toasts; destructive
// actions go through a confirm modal (replacing the old window.confirm()).
// The toast functions live in notify.js (JSX-free, importable from node);
// re-exported here so components keep one import site.
export { notifySuccess, notifyError, notifyWarning } from './notify.js';

// A toast for work in flight, updated in place when the promise settles.
// `success` and `error` may be strings or functions of the settled value.
export const notifyPromise = (promise, { loading, success, error }) => {
  const id = randomId();
  const resolve = (v, value) => (typeof v === 'function' ? v(value) : v);
  notifications.show({
    id,
    message: loading,
    loading: true,
    autoClose: false,
    withCloseButton: false,
  });
  return promise.then(
    (value) => {
      notifications.update({
        id,
        message: resolve(success, value),
        color: 'green',
        loading: false,
        autoClose: 5000,
        withCloseButton: true,
      });
      return value;
    },
    (err) => {
      notifications.update({
        id,
        title: 'Error',
        message: resolve(error, err),
        color: 'red',
        loading: false,
        autoClose: 8000,
        withCloseButton: true,
      });
      throw err;
    },
  );
};

// A toast carrying a single action button. Mantine has no equivalent of
// sonner's `action`, so the button rides in the message. It stays up long
// enough to be acted on, and dismisses itself once clicked.
export const notifyWithAction = (
  message,
  title,
  { label, onClick, color = 'green', autoClose = 15000 },
) => {
  const id = randomId();
  notifications.show({
    id,
    title,
    color,
    autoClose,
    message: (
      <Group justify="space-between" wrap="nowrap" gap="sm" align="flex-start">
        <Text size="sm">{message}</Text>
        <Button
          size="compact-xs"
          variant="white"
          onClick={() => {
            notifications.hide(id);
            onClick();
          }}
        >
          {label}
        </Button>
      </Group>
    ),
  });
  return id;
};

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
