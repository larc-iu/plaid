import { toast } from 'sonner';

// App-wide feedback primitives (sonner-backed). Transient outcomes are toasts.
// Signature mirrors plaid-ud's feedback util: (message, title?).
// Destructive confirms go through the shadcn <AlertDialog> component, not here.

export const notifySuccess = (message, title) =>
  toast.success(title || message, title ? { description: message } : undefined);

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

export const notifyError = (message, title = 'Error') =>
  toast.error(title, { description: scrubTransport(message) });

export const notifyInfo = (message, title) =>
  toast(title || message, title ? { description: message } : undefined);

export const notifyWarning = (message, title = 'Warning', options) =>
  toast.warning(title, { description: message, ...options });

// Pull an HTTP status off an error object or its message ("HTTP 423 …").
const statusOf = (error) => {
  if (error && typeof error.status === 'number') return error.status;
  const m = String((error && error.message) || error || '').match(/\bHTTP (\d{3})\b/);
  return m ? Number(m[1]) : null;
};

const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

// True for the "you can't see/do this" / "no accessible projects" class — used
// to suppress noisy warnings on screens a low-privilege user legitimately opens
// (e.g. a vocab-only maintainer viewing the vocab list, where count queries 400).
export const isPermissionError = (error) => {
  const s = statusOf(error);
  if (s === 401 || s === 403) return true;
  const msg = String((error && error.message) || error || '');
  return /no accessible projects|lacks sufficient privileges|not authoriz/i.test(msg);
};

// Turn a raw client/HTTP error into a user-facing message: map known statuses to
// friendly text, and otherwise scrub internal API URLs and bare UUIDs so we never
// surface stack-trace-like internals (e.g. "… at http://localhost:8080/api/v1/…").
const UNREACHABLE = 'Could not reach the server. Check your connection and try again.';
const isUnreachable = (error) => {
  const s = statusOf(error);
  if (s === 0 || s === 502 || s === 503 || s === 504) return true;
  const msg = String((error && error.message) || error || '');
  // fetch's TypeError, an aborted/timed-out request, or the dev proxy's bodyless 500.
  return /Failed to fetch|NetworkError|timed out|Unable to read error response/i.test(msg);
};

export const humanizeError = (error, fallback = 'Something went wrong.') => {
  if (isUnreachable(error)) return UNREACHABLE;
  switch (statusOf(error)) {
    case 401:
      return 'Your session has expired. Please sign in again.';
    case 403:
      return "You don't have permission to do that.";
    case 404:
      return 'That item could not be found.';
    case 409:
      // Document mutations auto-resync after a conflict (IgtDocument._withSaving
      // reloads), so don't tell the user to reload by hand.
      return 'This changed elsewhere since you loaded it. It has been refreshed to the latest version, so redo your edit.';
    case 423:
      return 'This document is being edited right now (by another user or a service). Try again in a moment.';
    case 500:
      return 'The server hit an unexpected error. Try again in a moment.';
    default:
      break;
  }
  const msg = String((error && error.message) || error || '')
    .replace(/\s*at\s+https?:\/\/\S+/gi, '') // " at http://…/api/v1/…"
    .replace(UUID_RE, 'this item')
    .replace(/^HTTP \d+\s*/i, '')
    .trim();
  return msg || fallback;
};

// Re-export the raw toast for advanced cases (promise toasts, custom JSX, etc.).
export { toast };
