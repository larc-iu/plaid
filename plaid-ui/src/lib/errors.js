// Turning a raw client or HTTP error into something a person should read.
//
// Every app's error toast passes through here, so the scrubbing happens once:
// a client error's message carries the request URL and the bare ids it was
// given ("HTTP 400 … at http://host/api/v1/…"), and none of that belongs on
// screen.

// Pull an HTTP status off an error object or its message ("HTTP 423 …").
export const statusOf = (error) => {
  if (error && typeof error.status === 'number') return error.status;
  const m = String((error && error.message) || error || '').match(/\bHTTP (\d{3})\b/);
  return m ? Number(m[1]) : null;
};

export const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

// True for the "you cannot see or do this" class, so a screen a low-privilege
// user legitimately opens can stay quiet about the reads it is refused.
export const isPermissionError = (error) => {
  const s = statusOf(error);
  if (s === 401 || s === 403) return true;
  const msg = String((error && error.message) || error || '');
  return /no accessible projects|lacks sufficient privileges|not authoriz/i.test(msg);
};

const UNREACHABLE = 'Could not reach the server. Check your connection and try again.';

const isUnreachable = (error) => {
  const s = statusOf(error);
  if (s === 0 || s === 502 || s === 503 || s === 504) return true;
  const msg = String((error && error.message) || error || '');
  // fetch's TypeError, an aborted or timed-out request, or the dev proxy's
  // bodyless 500.
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
      // Both apps resync a document after a conflict, so the user is never
      // told to reload by hand.
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
