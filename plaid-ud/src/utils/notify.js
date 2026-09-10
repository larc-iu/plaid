import { toast } from 'sonner';

// Toast primitives, kept JSX-free so non-UI modules (the ConlluDocument
// domain layer, and node-run tests) can import them without a JSX loader.
// Components usually import these via feedback.jsx, which re-exports them
// alongside the confirm helper.
//
// `options` is passed straight to sonner. The one worth knowing is
// `duration: Infinity`, which makes a notice stick until dismissed.

export const notifySuccess = (message, title, options) =>
  toast.success(title || message, { ...(title ? { description: message } : {}), ...options });

export const notifyError = (message, title = 'Error', options) =>
  toast.error(title, { description: message, ...options });

// A loud, non-error notice (e.g. an automatic repair the user should review).
export const notifyWarning = (message, title = 'Heads up', options) =>
  toast.warning(title, { description: message, ...options });
