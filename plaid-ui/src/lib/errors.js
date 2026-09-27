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

const UNREACHABLE = 'Failed to reach the server. Check your connection and try again.';

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

// A write whose answer never came back: the connection dropped, the answer
// was garbled, or the server took longer than the client waits (a gateway
// timeout included). The server may have made the change, so it is not the
// network's "could not reach" but its own case. The client puts the request's
// `method` on the error, and a read changes nothing either way.
//
// A few reads go as a POST (a query, signing in, looking an invite up), and
// saved nothing either way.
const READ_POSTS = /\/api\/v1\/(query|login|invites\/lookup)(?:[?#]|$)/;

export const isUnknownOutcome = (error) => {
  const method = String((error && error.method) || '').toUpperCase();
  if (!method || method === 'GET' || method === 'HEAD') return false;
  const url = String(error.url || String(error.message || '').match(/\bat (\S+)$/)?.[1] || '');
  if (READ_POSTS.test(url)) return false;
  const s = statusOf(error);
  return s === 0 || s === 504 || (s === null && isUnreachable(error));
};

export const UNKNOWN_OUTCOME_TITLE = 'Not confirmed';
const UNKNOWN_OUTCOME =
  'The server did not answer in time. This change may or may not have been saved.';

// A message that names a record by its id was written for a developer. A
// sentence with the id swapped for a stand-in word reads broken ("Vocab item
// this item not found"), so such a message is replaced whole: a missing
// record is "Not found.", anything else is the caller's fallback (itself
// passed over when it too names an id). The toast's title already names the
// action that failed.
const namesAnId = (msg) => msg.search(UUID_RE) !== -1;

// plaid-client's DocumentLockLost, whose message names the document by id. A
// document model folds it into a string ("Failed to …: The lock on document
// … lapsed"), so the message is read as well as the name.
const isLockLost = (error) =>
  (error && error.name === 'DocumentLockLost') ||
  /\block on document \S+ lapsed\b/i.test(String((error && error.message) || error || ''));

export const humanizeError = (error, fallback = 'Something went wrong.') => {
  if (isUnknownOutcome(error)) return UNKNOWN_OUTCOME;
  if (isUnreachable(error)) return UNREACHABLE;
  if (isLockLost(error)) return 'The lock on this document lapsed.';
  // An edit that names a row by the id it was shown under before the server
  // made it (pendingIds.js): the create it waited on was refused.
  if (statusOf(error) === 400 && /\bshould be a uuid\b/i.test(String(error?.message ?? error))) {
    return 'Depends on an edit that was not saved.';
  }
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
  const fallbackSaid = namesAnId(String(fallback)) ? 'Something went wrong.' : fallback;
  if (namesAnId(msg)) return /\bnot found\b/i.test(msg) ? 'Not found.' : fallbackSaid;
  return msg || fallbackSaid;
};

// A sign-in that fails says one thing to the person typing, so the general
// wording for 401 ("your sign-in is no longer valid") does not belong on that screen.
// Everything else reads as it does everywhere: a server that is down, a 500.
export const signInError = (error) =>
  statusOf(error) === 401
    ? 'Email or password is incorrect.'
    : humanizeError(error, 'Could not sign in.');
