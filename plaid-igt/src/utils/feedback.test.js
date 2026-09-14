import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), warning: vi.fn() }),
}));

import { toast } from 'sonner';
import { notifyError, humanizeError } from './feedback.js';

beforeEach(() => toast.error.mockClear());

describe('notifyError', () => {
  it('scrubs the transport noise off a raw client message', () => {
    notifyError(
      'HTTP 400 :value has an invalid regex: Unclosed group near index 1 ( at http://localhost:5174/api/v1/query',
    );
    expect(toast.error).toHaveBeenCalledWith('Error', {
      description: ':value has an invalid regex: Unclosed group near index 1 (',
    });
  });
  it('leaves an ordinary message alone', () => {
    notifyError('Failed to create user: name taken', 'Oops');
    expect(toast.error).toHaveBeenCalledWith('Oops', {
      description: 'Failed to create user: name taken',
    });
  });
  it('says what a locked document means, not "Locked"', () => {
    notifyError({ status: 423, message: 'HTTP 423 Locked at http://localhost:5174/api/v1/spans' });
    expect(toast.error).toHaveBeenCalledWith('Error', {
      description:
        'This document is being edited right now (by another user or a service). Try again in a moment.',
    });
  });
  it('reads a status off a bare message too', () => {
    notifyError('HTTP 423 Locked');
    expect(toast.error.mock.calls[0][1].description).toMatch(/being edited right now/);
  });
});

describe('humanizeError', () => {
  it('explains an unreachable server in one way', () => {
    const want = /Could not reach the server/;
    expect(humanizeError({ status: 0, message: 'Failed to fetch' })).toMatch(want);
    expect(
      humanizeError({ status: 503, message: 'HTTP 503 Service Unavailable at http://x' }),
    ).toMatch(want);
    expect(
      humanizeError({ status: 500, message: 'HTTP 500 Unable to read error response at http://x' }),
    ).toMatch(want);
    expect(humanizeError(new TypeError('Failed to fetch'))).toMatch(want);
  });
  it('keeps a real 500 distinct', () => {
    expect(humanizeError({ status: 500, message: 'HTTP 500 boom at http://x' })).toMatch(
      /unexpected error/,
    );
  });
  it('maps known statuses', () => {
    expect(humanizeError({ status: 403 })).toMatch(/permission/);
  });
  it('strips URLs and ids otherwise', () => {
    expect(
      humanizeError({
        message: 'HTTP 400 bad thing 01a04095-38c4-74d1-8450-a7d6a0267af7 at http://x/api',
      }),
    ).toBe('bad thing this item');
  });
});
