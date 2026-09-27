import { describe, it, expect } from 'vitest';
import {
  humanizeError,
  isPermissionError,
  isUnknownOutcome,
  signInError,
  statusOf,
} from './errors.js';

// The one place a status becomes a sentence. What it has to hold: a client
// error's raw message carries the request URL and the ids it was given, and
// screens all over both apps used to hand that message to a toast or a banner
// untouched. Passing the ERROR rather than its message is what lets the status
// be read rather than parsed back out of the text.

const httpError = (status, said = 'Nope') => {
  const e = new Error(`HTTP ${status} ${said} at http://localhost:8085/api/v1/projects/abc`);
  e.status = status;
  return e;
};

describe('reading a status', () => {
  it('takes it off the error', () => {
    expect(statusOf(httpError(423))).toBe(423);
  });

  it('parses it back out of a message when that is all there is', () => {
    expect(statusOf('HTTP 409 conflict at http://x/y')).toBe(409);
  });

  it('answers null when there is none', () => {
    expect(statusOf(new Error('the disk is on fire'))).toBe(null);
    expect(statusOf(null)).toBe(null);
  });
});

describe('what a person is told', () => {
  it('says the same sentence for a status whether or not the object carries it', () => {
    const withObject = humanizeError(httpError(403));
    const withMessage = humanizeError(httpError(403).message);
    expect(withObject).toBe(withMessage);
    expect(withObject).toBe("You don't have permission to do that.");
  });

  it('never shows the request URL or a bare id', () => {
    const said = humanizeError(
      new Error('Bad request 11111111-2222-3333-4444-555555555555 at http://localhost:8085/api/v1'),
    );
    expect(said).not.toMatch(/http/);
    expect(said).not.toMatch(/1111/);
  });

  it('says a record named by its id is not found, without swapping a stand-in word for the id', () => {
    expect(
      humanizeError(new Error('Vocab item 01a04095-38c4-74d1-8450-a7d6a0267af7 not found')),
    ).toBe('Not found.');
    expect(humanizeError('Morpheme 01a04095-38c4-74d1-8450-a7d6a0267af7 not found')).toBe(
      'Not found.',
    );
  });

  it('shows the fallback for any other message that names a record by its id', () => {
    expect(
      humanizeError(
        new Error('HTTP 400 Token 01a04095-38c4-74d1-8450-a7d6a0267af7 is out of bounds'),
        'Could not save.',
      ),
    ).toBe('Could not save.');
  });

  it('words a lapsed document lock without the document id', () => {
    const lost = new Error(
      'The lock on document 01a04095-38c4-74d1-8450-a7d6a0267af7 lapsed: it could not be renewed.',
    );
    lost.name = 'DocumentLockLost';
    expect(humanizeError(lost)).toBe('The lock on this document lapsed.');
    // What a document model's error channel carries: the label and the message, as one string.
    expect(humanizeError(`Failed to split morpheme: ${lost.message}`)).toBe(
      'The lock on this document lapsed.',
    );
  });

  it('passes over a fallback that itself names an id', () => {
    const raw =
      'Failed to split morpheme: Token 01a04095-38c4-74d1-8450-a7d6a0267af7 out of bounds';
    expect(humanizeError(raw, raw)).toBe('Something went wrong.');
  });

  it('never says "item"', () => {
    for (const e of [
      httpError(404),
      new Error('Vocab item 01a04095-38c4-74d1-8450-a7d6a0267af7 not found'),
      new Error('bad thing 01a04095-38c4-74d1-8450-a7d6a0267af7'),
    ]) {
      expect(humanizeError(e)).not.toMatch(/\bitem\b/);
    }
  });

  it('names the network rather than the server when the server was never reached', () => {
    expect(humanizeError(new TypeError('Failed to fetch'))).toMatch(/Check your connection/);
    expect(humanizeError(httpError(503))).toMatch(/Check your connection/);
  });

  it('falls back only when there is nothing to say', () => {
    expect(humanizeError(null, 'Nothing loaded.')).toBe('Nothing loaded.');
    expect(humanizeError(new Error('  '), 'Nothing loaded.')).toBe('Nothing loaded.');
    expect(humanizeError(new Error('the disk is on fire'), 'Nothing loaded.')).toBe(
      'the disk is on fire',
    );
  });

  it('recognises the refusals a screen may stay quiet about', () => {
    expect(isPermissionError(httpError(403))).toBe(true);
    expect(isPermissionError(httpError(401))).toBe(true);
    expect(isPermissionError(httpError(404))).toBe(false);
  });
});

describe('a failed sign-in', () => {
  it('does not tell someone typing a password that their session expired', () => {
    expect(signInError(httpError(401, 'Invalid credentials'))).toBe(
      'Email or password is incorrect.',
    );
  });

  it('says what else went wrong, in the usual words', () => {
    expect(signInError(new TypeError('Failed to fetch'))).toMatch(/Check your connection/);
    expect(signInError(httpError(500))).toMatch(/unexpected error/);
  });

  it('shows no URL whatever happened', () => {
    for (const status of [400, 401, 403, 500, 503]) {
      expect(signInError(httpError(status))).not.toMatch(/http/);
    }
  });
});

// A write whose answer never came back may have landed: the connection
// dropped, the answer was garbled, or the server took longer than the client
// waits. The client says which request it was (`method`).
describe('a write whose answer was lost', () => {
  const lost = (method, message = 'Network error: Failed to fetch at http://x/api/v1/spans') =>
    Object.assign(new Error(message), { status: 0, method });
  const MAYBE = 'The server did not answer in time. This change may or may not have been saved.';

  it('is told apart from a read that could not reach the server', () => {
    expect(isUnknownOutcome(lost('POST'))).toBe(true);
    expect(isUnknownOutcome(lost('PATCH', 'Request timed out at http://x/api/v1/spans'))).toBe(
      true,
    );
    expect(isUnknownOutcome(lost('DELETE', 'Network error: Unexpected token < at http://x'))).toBe(
      true,
    );
    expect(isUnknownOutcome(Object.assign(httpError(504), { method: 'PUT' }))).toBe(true);
    expect(isUnknownOutcome(lost('GET'))).toBe(false);
    expect(isUnknownOutcome(new TypeError('Failed to fetch'))).toBe(false);
    expect(isUnknownOutcome(Object.assign(httpError(500), { method: 'POST' }))).toBe(false);
    expect(isUnknownOutcome(Object.assign(httpError(503), { method: 'POST' }))).toBe(false);
  });

  it('says it may or may not have been saved', () => {
    expect(humanizeError(lost('POST'))).toBe(MAYBE);
    expect(humanizeError(lost('get'))).toMatch(/Failed to reach the server/);
  });

  // An edit made on a row whose create was refused names it by the id it was
  // shown under, which the server takes for a malformed request.
  it('says an edit depended on one that was not saved', () => {
    const e = Object.assign(
      new Error(
        'HTTP 400 Request validation failed. span-id: should be a uuid at http://x/api/v1/spans/pending:1',
      ),
      { status: 400, method: 'PATCH' },
    );
    expect(humanizeError(e)).toBe('Depends on an edit that was not saved.');
    expect(
      humanizeError(
        Object.assign(new Error('HTTP 400 Request validation failed. tokens: should be a uuid'), {
          status: 400,
        }),
      ),
    ).toBe('Depends on an edit that was not saved.');
  });

  // A few reads are POSTs: a query, signing in, looking an invite up. Nothing
  // can have been saved by them.
  it('is not a read sent as a POST', () => {
    const at = (url, message = 'Network error: Failed to fetch') =>
      Object.assign(new Error(`${message} at ${url}`), { status: 0, method: 'POST', url });
    expect(isUnknownOutcome(at('http://x/api/v1/query'))).toBe(false);
    expect(isUnknownOutcome(at('http://x/api/v1/query?as-of=2026-01-01'))).toBe(false);
    expect(isUnknownOutcome(at('http://x/api/v1/login', 'Request timed out'))).toBe(false);
    expect(isUnknownOutcome(at('http://x/api/v1/invites/lookup'))).toBe(false);
    expect(signInError(at('http://x/api/v1/login'))).toMatch(/Failed to reach the server/);
    expect(isUnknownOutcome(at('http://x/api/v1/invites/redeem'))).toBe(true);
    expect(isUnknownOutcome(at('http://x/api/v1/query-log'))).toBe(true);
  });
});
