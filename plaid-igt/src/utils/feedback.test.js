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
  it('falls back to the original when scrubbing empties it', () => {
    notifyError('HTTP 500');
    expect(toast.error).toHaveBeenCalledWith('Error', { description: 'HTTP 500' });
  });
});

describe('humanizeError', () => {
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
