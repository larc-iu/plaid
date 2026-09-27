import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }),
}));

import { toast } from 'sonner';
import { notifyError } from './feedback.js';

beforeEach(() => toast.error.mockClear());

describe('notifyError', () => {
  it('says the server could not be reached, not the client text', () => {
    notifyError('Network error: Failed to fetch');
    expect(toast.error.mock.calls[0][1].description).toBe(
      'Could not reach the server. Check your connection and try again.',
    );
  });

  it('words a status, not the server message', () => {
    notifyError('HTTP 500 java.lang.NullPointerException at http://localhost:5175/api/v1/x');
    expect(toast.error.mock.calls[0][1].description).toBe(
      'The server hit an unexpected error. Try again in a moment.',
    );
  });

  it('keeps a message of its own', () => {
    notifyError('Not every entry was published. Try again.', 'Publishing stopped');
    expect(toast.error).toHaveBeenCalledWith('Publishing stopped', {
      description: 'Not every entry was published. Try again.',
    });
  });
});
