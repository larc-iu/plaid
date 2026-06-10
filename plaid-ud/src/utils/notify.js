import { notifications } from '@mantine/notifications';

// Toast primitives, kept JSX-free so non-UI modules (the ConlluDocument
// domain layer, and node-run tests) can import them without a JSX loader.
// Components usually import these via feedback.jsx, which re-exports them
// alongside the modal helpers.

export const notifySuccess = (message, title) =>
  notifications.show({ title, message, color: 'green' });

export const notifyError = (message, title = 'Error') =>
  notifications.show({ title, message, color: 'red' });

// A loud, non-error notice (e.g. an automatic repair the user should review).
// `options` is spread onto Mantine's notifications.show — pass `autoClose: false`
// to make it stick until dismissed.
export const notifyWarning = (message, title = 'Heads up', options = {}) =>
  notifications.show({ title, message, color: 'yellow', ...options });
