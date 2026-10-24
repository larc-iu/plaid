import { describe, it, expect, vi, beforeEach } from 'vitest';

const toast = Object.assign(vi.fn(), {
  error: vi.fn(),
  success: vi.fn(),
  warning: vi.fn(),
});
vi.mock('sonner', () => ({ toast }));

const { notifyError, notifyWarning } = await import('./notify.js');
const { humanizeError } = await import('./errors.js');

beforeEach(() => toast.error.mockClear());

describe('notifyError', () => {
  it('says what a locked document means, not "Locked"', () => {
    notifyError({ status: 423, message: 'HTTP 423 Locked at http://localhost:8085/api/v1/spans' });
    expect(toast.error).toHaveBeenCalledWith(
      'This document is being edited right now (by another user or a service). Try again in a moment.',
      {},
    );
  });

  it('reads a status off a bare message too', () => {
    notifyError('HTTP 423 Locked');
    expect(toast.error.mock.calls[0][0]).toMatch(/being edited right now/);
  });

  it('does not show a message that names a record by its id', () => {
    notifyError('HTTP 400 bad thing 01a04095-38c4-74d1-8450-a7d6a0267af7 at http://x/api/v1/spans');
    expect(toast.error.mock.calls[0][0]).toBe('Something went wrong.');
  });

  it('never titles a toast with a bare "Error" or "Warning"', () => {
    notifyError('Expiry must be at least 1 day.');
    expect(toast.error).toHaveBeenCalledWith('Expiry must be at least 1 day.', {});
    notifyWarning('No changes to save');
    expect(toast.warning).toHaveBeenCalledWith('No changes to save', {});
  });

  it('leaves an ordinary message alone', () => {
    notifyError('Failed to create user: name taken', 'Oops');
    expect(toast.error).toHaveBeenCalledWith('Oops', {
      description: 'Failed to create user: name taken',
    });
  });

  it('titles a write whose answer was lost "Not confirmed", whatever the caller called it', () => {
    notifyError(
      Object.assign(new Error('Request timed out at http://x/api/v1/vocab-items'), {
        status: 0,
        method: 'POST',
      }),
      'Failed to save the entry',
    );
    expect(toast.error).toHaveBeenCalledWith('Not confirmed', {
      description: 'The server did not answer in time. This change may or may not have been saved.',
    });
  });

  // R4-3-1: about 78 callers hand over humanizeError(err), a string, and the
  // title was theirs ("Failed to delete project") over a body that said the
  // change may have been saved.
  it.each([502, 504, 0])('titles a humanized %s write "Not confirmed" too', (status) => {
    const err = Object.assign(new Error(`HTTP ${status} at http://x/api/v1/projects/p1`), {
      status,
      method: 'DELETE',
    });
    notifyError(humanizeError(err), 'Failed to delete project');
    expect(toast.error).toHaveBeenCalledWith('Not confirmed', {
      description: 'The server did not answer in time. This change may or may not have been saved.',
    });
  });

  it("keeps the caller's title on a humanized refusal", () => {
    const err = Object.assign(new Error('HTTP 423 Locked'), { status: 423, method: 'POST' });
    notifyError(humanizeError(err), 'Failed to save');
    expect(toast.error.mock.calls[0][0]).toBe('Failed to save');
  });
});
