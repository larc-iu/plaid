import { toast } from 'sonner';

// The error vocabulary is shared with plaid-ud through plaid-ui, and
// re-exported here so this file stays the one import every screen uses.
export { humanizeError, isPermissionError, statusOf } from '@ui/lib/errors.js';

// App-wide feedback primitives (sonner-backed). Transient outcomes are toasts.
// Signature mirrors plaid-ud's feedback util: (message, title?).
// Destructive confirms go through the shadcn <AlertDialog> component, not here.

export const notifySuccess = (message, title, options) =>
  toast.success(title || message, { ...(title ? { description: message } : {}), ...options });

// Every error toast passes through here, and many callers hand over a raw
// client `err.message` ("HTTP 400 … at http://host/api/v1/…"). Scrub the
// transport noise once, centrally, so no toast shows an internal URL.
const scrubTransport = (message) =>
  typeof message === 'string'
    ? message
        .replace(/\s*at\s+https?:\/\/\S+/gi, '')
        .replace(/^HTTP \d{3}\s*/i, '')
        .trim() || message
    : message;

export const notifyError = (message, title = 'Error', options) =>
  toast.error(title, { description: scrubTransport(message), ...options });

export const notifyInfo = (message, title) =>
  toast(title || message, title ? { description: message } : undefined);

export const notifyWarning = (message, title = 'Warning', options) =>
  toast.warning(title, { description: message, ...options });

// A toast that follows a promise: `loading` while it runs, then `success`
// (a string, or a function of the result) or `error` (a function of the
// error) as the outcome.
export const notifyPromise = (promise, { loading, success, error }) =>
  toast.promise(promise, { loading, success, error });

// Re-export the raw toast for advanced cases (promise toasts, custom JSX, etc.).
export { toast };
