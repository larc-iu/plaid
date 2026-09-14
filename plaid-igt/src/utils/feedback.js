import { toast } from 'sonner';

// The error vocabulary is shared with plaid-ud through plaid-ui, and
// re-exported here so this file stays the one import every screen uses.
import { humanizeError } from '@ui/lib/errors.js';

export { humanizeError, isPermissionError } from '@ui/lib/errors.js';

// App-wide feedback primitives (sonner-backed). Transient outcomes are toasts.
// Signature mirrors plaid-ud's feedback util: (message, title?).
// Destructive confirms go through the shadcn <AlertDialog> component, not here.

export const notifySuccess = (message, title, options) =>
  toast.success(title || message, { ...(title ? { description: message } : {}), ...options });

// Every error toast passes through `humanizeError`, so a status reads as the
// same sentence in every app and no toast shows an internal URL or a bare id.
// Callers that hold the error OBJECT should still pass it, so its status is
// read rather than parsed back out of a message. Running it twice changes
// nothing.
export const notifyError = (message, title = 'Error', options) =>
  toast.error(title, { description: humanizeError(message), ...options });

export const notifyInfo = (message, title) =>
  toast(title || message, title ? { description: message } : undefined);

export const notifyWarning = (message, title = 'Warning', options) =>
  toast.warning(title, { description: message, ...options });

// A toast that follows a promise: `loading` while it runs, then `success`
// (a string, or a function of the result) or `error` (a function of the
// error) as the outcome.
export const notifyPromise = (promise, { loading, success, error }) =>
  toast.promise(promise, { loading, success, error });
