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

// A failure that is the network's and passes once it is back. The write queue
// (domain/WriteQueue.js) waits out exactly these, so what a toast calls "Could
// not reach the server" is what the queue keeps retrying. This file imports
// nothing, which is what lets the queue share it.
export const isUnreachable = (error) => {
  const s = statusOf(error);
  if (s === 0 || s === 502 || s === 503 || s === 504) return true;
  const msg = String((error && error.message) || error || '');
  // fetch's TypeError, an aborted or timed-out request, or the dev proxy's
  // bodyless 500.
  return /Failed to fetch|NetworkError|timed out|Unable to read error response/i.test(msg);
};

// A message that names a record by its id was written for a developer. A
// sentence with the id swapped for a stand-in word reads broken ("Vocab item
// this item not found"), so such a message is replaced whole: a missing
// record is "Not found.", anything else is the caller's fallback. The toast's
// title already names the action that failed.
const namesAnId = (msg) => msg.search(UUID_RE) !== -1;

export const humanizeError = (error, fallback = 'Something went wrong.') => {
  if (isUnreachable(error)) return UNREACHABLE;
  // plaid-client's DocumentLockLost, whose message names the document by id.
  if (error && error.name === 'DocumentLockLost') return 'The lock on this document lapsed.';
  switch (statusOf(error)) {
    case 401:
      return 'Your sign-in is no longer valid.';
    case 403:
      return "You don't have permission to do that.";
    case 404:
      return 'Not found.';
    case 409:
      // Both apps resync a document after a conflict, so the user is never
      // told to reload by hand.
      return 'Changed elsewhere. Now showing the latest version. Redo your edit.';
    case 423:
      return 'This document is being edited right now (by another user or a service). Try again in a moment.';
    case 500:
      return 'The server hit an unexpected error. Try again in a moment.';
    default:
      break;
  }
  const msg = String((error && error.message) || error || '')
    .replace(/\s*at\s+https?:\/\/\S+/gi, '') // " at http://…/api/v1/…"
    .replace(/^HTTP \d+\s*/i, '')
    .trim();
  if (namesAnId(msg)) return /\bnot found\b/i.test(msg) ? 'Not found.' : fallback;
  return msg || fallback;
};

// A sign-in that fails says one thing to the person typing, so the general
// wording for 401 ("your sign-in is no longer valid") does not belong on that screen.
// Everything else reads as it does everywhere: a server that is down, a 500.
export const signInError = (error) =>
  statusOf(error) === 401
    ? 'Email or password is incorrect.'
    : humanizeError(error, 'Could not sign in.');
