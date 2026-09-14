import { describe, it, expect } from 'vitest';
import { humanizeError, isPermissionError, signInError, statusOf } from './errors.js';

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
