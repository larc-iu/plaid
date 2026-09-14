import { describe, it, expect, vi, beforeEach } from 'vitest';

const toast = Object.assign(vi.fn(), {
  error: vi.fn(),
  success: vi.fn(),
  warning: vi.fn(),
});
vi.mock('sonner', () => ({ toast }));

const { notifyError } = await import('./notify.js');

beforeEach(() => toast.error.mockClear());

describe('notifyError', () => {
  it('says what a locked document means, not "Locked"', () => {
    notifyError({ status: 423, message: 'HTTP 423 Locked at http://localhost:8085/api/v1/spans' });
    expect(toast.error).toHaveBeenCalledWith('Error', {
      description:
        'This document is being edited right now (by another user or a service). Try again in a moment.',
    });
  });

  it('reads a status off a bare message too', () => {
    notifyError('HTTP 423 Locked');
    expect(toast.error.mock.calls[0][1].description).toMatch(/being edited right now/);
  });

  it('strips the transport noise and the ids off anything else', () => {
    notifyError('HTTP 400 bad thing 01a04095-38c4-74d1-8450-a7d6a0267af7 at http://x/api/v1/spans');
    expect(toast.error.mock.calls[0][1].description).toBe('bad thing this item');
  });

  it('leaves an ordinary message alone', () => {
    notifyError('Failed to create user: name taken', 'Oops');
    expect(toast.error).toHaveBeenCalledWith('Oops', {
      description: 'Failed to create user: name taken',
    });
  });
});
