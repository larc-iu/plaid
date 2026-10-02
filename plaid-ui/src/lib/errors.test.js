import { describe, it, expect } from 'vitest';
import {
  humanizeError,
  isChangedElsewhere,
  isGone,
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
  it('tells a create whose row is there from one whose row was deleted since', () => {
    const taken = (deleted) =>
      Object.assign(httpError(409, 'id-taken'), {
        responseData: { error: 'id-taken', 'id-taken': true, id: 'x', deleted },
      });
    expect(humanizeError(taken(false))).toBe('This was saved already.');
    expect(humanizeError(taken(true))).toBe('This was deleted.');
  });

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

  // A gateway answers 502 both when the server was down and when it stored
  // the write and then dropped the connection (V5, H5-2 and H7-3).
  it('counts a 502 on a write as lost, and on a read as the network', () => {
    const bad = (method) =>
      Object.assign(httpError(502, 'Unable to read error response'), {
        method,
        url: 'http://x/api/v1/spans',
      });
    expect(isUnknownOutcome(bad('POST'))).toBe(true);
    expect(isUnknownOutcome(bad('PATCH'))).toBe(true);
    expect(humanizeError(bad('POST'))).toBe(MAYBE);
    expect(isUnknownOutcome(bad('GET'))).toBe(false);
    expect(humanizeError(bad('GET'))).toMatch(/Failed to reach the server/);
  });

  it('says it may or may not have been saved', () => {
    expect(humanizeError(lost('POST'))).toBe(MAYBE);
    expect(humanizeError(lost('get'))).toMatch(/Failed to reach the server/);
  });

  // An edit made on a row whose create was refused is held back unsent by the
  // document model, with this message.
  it('says an edit depended on one that was not saved', () => {
    const e = Object.assign(new Error('HTTP 400 The edit this one depends on was not saved.'), {
      status: 400,
    });
    expect(humanizeError(e)).toBe('Depends on an edit that was not saved.');
  });

  // Q1-IGT-POLISH-1: a comment on an unanalyzed word's morpheme sent its
  // derived id, and the 400 was read as a refused create the user never made.
  it('reads a request the server could not parse as the caller fallback, not a lost edit', () => {
    const e = Object.assign(
      new Error('HTTP 400 Request validation failed. entity-id: should be a uuid'),
      { status: 400, method: 'POST' },
    );
    expect(humanizeError(e)).toBe('Something went wrong.');
    expect(humanizeError(e, 'Failed to post the comment.')).toBe('Failed to post the comment.');
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

// A writer's write to something another user deleted is answered 403 with no
// project named (the core's unknown-id ruling), an admin's 404 (D3).
describe('a write to something that is gone', () => {
  const refused = (status, said, method = 'PATCH') =>
    Object.assign(httpError(status, said), {
      method,
      responseData: { error: said },
    });
  const GONE = 'Changed or removed by someone else.';

  it('is told apart from a refusal that names its project', () => {
    const gone = refused(
      403,
      'User b@x.com lacks sufficient privileges to write the project this entity belongs to',
    );
    expect(isGone(gone)).toBe(true);
    expect(isChangedElsewhere(gone)).toBe(true);
    expect(humanizeError(gone)).toBe(GONE);
    const real = refused(
      403,
      'User b@x.com lacks sufficient privileges to write project 0199aaaa-0000-7000-8000-000000000001',
    );
    expect(isGone(real)).toBe(false);
    expect(humanizeError(real)).toBe("You don't have permission to do that.");
  });

  it("reads the server's unresolved field before the wording (D23)", () => {
    const said = 'Any wording at all, naming vocab layer 0199aaaa-0000';
    const gone = Object.assign(httpError(403, said), {
      method: 'DELETE',
      responseData: { error: said, unresolved: true },
    });
    expect(isGone(gone)).toBe(true);
    expect(humanizeError(gone)).toBe(GONE);
    expect(isGone(refused(403, said, 'DELETE'))).toBe(false);
    expect(isGone({ ...gone, method: 'GET' })).toBe(false);
  });

  it('reads the message off the error when the body is not there', () => {
    const e = Object.assign(
      new Error(
        'HTTP 403 User b@x.com lacks sufficient privileges to write the project this entity belongs to at http://x/api/v1/spans/1',
      ),
      { status: 403, method: 'POST' },
    );
    expect(isGone(e)).toBe(true);
  });

  it('covers a vocabulary entry whose vocabulary cannot be placed', () => {
    expect(isGone(refused(403, 'User b@x.com lacks read access to vocab layer ', 'POST'))).toBe(
      true,
    );
    expect(
      isGone(refused(403, 'User b@x.com lacks read access to vocab layer 0199aaaa-0000', 'POST')),
    ).toBe(false);
  });

  it('counts a 404 on a write, and never a read', () => {
    expect(humanizeError(refused(404, 'Not found', 'DELETE'))).toBe(GONE);
    expect(isGone(refused(404, 'Not found', 'GET'))).toBe(false);
    expect(humanizeError(refused(404, 'Not found', 'GET'))).toBe('Not found.');
    expect(isGone(httpError(404))).toBe(false);
  });

  it('is a change elsewhere, as a 409 is', () => {
    expect(isChangedElsewhere(refused(409, 'conflict'))).toBe(true);
    expect(isChangedElsewhere(refused(400, 'bad'))).toBe(false);
  });
});
