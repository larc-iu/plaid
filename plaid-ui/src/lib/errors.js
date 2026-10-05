// Turning a raw client or HTTP error into something a person should read.
//
// Every app's error toast passes through here, so the scrubbing happens once:
// a client error's message carries the request URL and the bare ids it was
// given ("HTTP 400 … at http://host/api/v1/…"), and none of that belongs on
// screen.

// The client's reader of a layer rule's refusal. By its real path: this file
// is reached from plain node, and that module imports nothing of the page.
import { violationsOf } from '../../../plaid-client-js/src/constraints.js';

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
// nothing of the page, which is what lets the queue share it.
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
// A 502 is one of them. A gateway answers it both when the server was down
// and when the server stored the write and then dropped the connection, and
// nothing in the answer tells the two apart.
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
  return s === 0 || s === 502 || s === 504 || (s === null && isUnreachable(error));
};

// A write refused because what it names is gone: another user deleted the
// word, the annotation or the entry since this screen read it. The server
// answers a writer 403 for an id it cannot place in a project (the core's
// unknown-id ruling) with `unresolved: true` in its body. An admin, and a
// route that looks the id up itself, answers 404. The message test is for an
// error that lost its body: then the message names no project, where a real
// refusal names the one it refused.
const GONE_403 =
  /\bthe project this entity belongs to\b|\baccess to vocab layer(?:\(s\))?\s*(?:\[\s*\])?$/i;

export const isGone = (error) => {
  const method = String((error && error.method) || '').toUpperCase();
  if (!method || method === 'GET' || method === 'HEAD') return false;
  const s = statusOf(error);
  if (s === 404) return true;
  if (s !== 403) return false;
  if (error?.responseData?.unresolved === true) return true;
  const said = String(error?.responseData?.error ?? '').trim();
  const msg = said || String(error?.message || '').replace(/\s+at\s+https?:\/\/\S+$/i, '');
  return GONE_403.test(msg.trim());
};

// A create refused because the id it names was used before (409 with
// `error: "id-taken"`): the page minted the id, so the create it sent earlier
// landed and its answer was lost. What was made is there under that id,
// unless `deleted` says it was deleted since.
export const isIdTaken = (error) =>
  statusOf(error) === 409 &&
  (error?.responseData?.error === 'id-taken' || error?.responseData?.['id-taken'] === true);

// A write refused because its Idempotency-Key was sent before with another
// request (422 with `error: "idempotency-key-reused"`).
export const isKeyReused = (error) =>
  statusOf(error) === 422 && error?.responseData?.error === 'idempotency-key-reused';

// A text save refused because the text, or the document, changed since the
// save was planned (409 `text-changed`, or the document's version): it is
// planned again on what is stored now. A taken id is not that.
export const isTextChanged = (error) => statusOf(error) === 409 && !isIdTaken(error);

// A write refused by a rule its layer declares (422 with `violations`): two
// heads on one word, a value outside a closed tagset, a relation across
// sentences. Nothing was stored. Not a conflict: the same write refused again
// the same way, so the screen puts the value back rather than refetch. The
// violations themselves are the client's `violationsOf`.
export const isConstraintViolation = (error) => violationsOf(error) !== null;

// A write refused because the document changed under it: a conflict (409),
// or what it names is gone. Either way the screen refetches and shows what
// is there now. A taken id is not that: it is the page's own create.
export const isChangedElsewhere = (error) =>
  (statusOf(error) === 409 && !isIdTaken(error)) || isGone(error);

export const UNKNOWN_OUTCOME_TITLE = 'Not confirmed';
const GONE = 'Changed or removed by someone else.';
const UNKNOWN_OUTCOME =
  'The server did not answer in time. This change may or may not have been saved.';

// A message that names a record by its id was written for a developer. A
// sentence with the id swapped for a stand-in word reads broken ("Vocab item
// this item not found"), so such a message is replaced whole: a missing
// record is "Not found.", anything else is the caller's fallback (itself
// passed over when it too names an id). The toast's title already names the
// action that failed.
const namesAnId = (msg) => msg.search(UUID_RE) !== -1;

const errorText = (error) => String((error && error.message) || error || '');

// plaid-client's DocumentLockLost, whose message names the document by id. A
// document model folds it into a string ("Failed to …: The lock on document
// … lapsed"), so the message is read as well as the name.
const isLockLost = (error) =>
  (error && error.name === 'DocumentLockLost') ||
  /\block on document \S+ lapsed\b/i.test(String((error && error.message) || error || ''));

// A query core stopped at its time limit (408), and one its queue of large
// queries had no room for before that limit (503). The clients wait past the
// limit, so these answers reach the page and are not taken for a lost
// connection.
const QUERY = /\/api\/v1\/query(?:[?#]|$)/;
const urlOf = (error) =>
  String(error?.url || String(error?.message || '').match(/\bat (\S+)$/)?.[1] || '');
const TOO_LONG = 'The search took too long. Narrow it and try again.';
const BUSY = 'The server is busy. Try again in a moment.';

export const humanizeError = (error, fallback = 'Something went wrong.') => {
  if (isUnknownOutcome(error)) return UNKNOWN_OUTCOME;
  if (statusOf(error) === 408) return TOO_LONG;
  if (statusOf(error) === 503 && QUERY.test(urlOf(error))) return BUSY;
  if (isUnreachable(error)) return UNREACHABLE;
  if (isGone(error)) return GONE;
  if (isLockLost(error)) return 'The lock on this document lapsed.';
  if (isIdTaken(error)) {
    return error.responseData?.deleted ? 'This was deleted.' : 'This was saved already.';
  }
  if (isKeyReused(error)) return 'This change was not sent: try it again.';
  // An upload over a recording someone else added since this page read the
  // document. Not "Redo your edit": redoing it would mean deleting theirs.
  if (statusOf(error) === 409 && error?.responseData?.['media-exists'] === true) {
    return 'Another recording was added elsewhere. Now showing it.';
  }
  // The server words the first violation by layer name, never by app.
  if (isConstraintViolation(error)) {
    const said = String(error.responseData.error ?? '').trim();
    return said && !namesAnId(said) ? said : 'Not allowed by the rules of this layer.';
  }
  // An edit that names a row whose create was refused, held back unsent by
  // the document model (DocumentModel.js `dependencyError`).
  if (statusOf(error) === 400 && /\bdepends on was not saved\b/i.test(errorText(error))) {
    return 'Depends on an edit that was not saved.';
  }
  // A request the server could not read (a malformed id, a missing field): a
  // fault of the page, which nothing on screen can explain.
  if (statusOf(error) === 400 && /\bRequest validation failed\b/i.test(errorText(error))) {
    return namesAnId(String(fallback)) ? 'Something went wrong.' : fallback;
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
    case 413:
      // Over the server's cap on a request's body. A document that long is
      // to be split (the huge-documents ruling), not sent in pieces.
      return 'This document is too large to save. Split it into shorter documents.';
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
    : humanizeError(error, 'Failed to sign in.');
