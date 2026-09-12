import { describe, it, expect, vi, beforeEach } from 'vitest';

// The toaster is bottom-right in all three apps, which is exactly where the
// docked panel's composer is. A success toast there covered the message the
// user was about to type, to repeat what the plan card beside it already says
// in green. Only the success one is dropped: a hard failure leaves the card
// undecided with no inline explanation, so its toast is the only place the
// reason ever appears.

vi.mock('../../lib/notify.js', () => ({
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  notifyWarning: vi.fn(),
}));

const { notifySuccess, notifyError, notifyWarning } = await import('../../lib/notify.js');
const { applyToasts } = await import('./jobs.js');

const applied = { outcome: { message: 'Applied 2 changes.' } };

describe('applyToasts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('says so on the full tab, where nothing is covered', () => {
    applyToasts(applied, '2 changes');
    expect(notifySuccess).toHaveBeenCalledTimes(1);
  });

  it('stays quiet in the docked panel, where the card says it', () => {
    applyToasts(applied, '2 changes', { docked: true });
    expect(notifySuccess).not.toHaveBeenCalled();
  });

  it('still reports a failure in the docked panel', () => {
    applyToasts({ error: { status: 500, message: 'boom' } }, 'x', { docked: true });
    expect(notifyError).toHaveBeenCalledTimes(1);
    expect(notifyError.mock.calls[0][0]).toMatch(/Approving again is safe/);
  });

  it('still reports lost contact in the docked panel', () => {
    applyToasts({ error: { pending: true } }, 'x', { docked: true });
    expect(notifyWarning).toHaveBeenCalledTimes(1);
  });

  it('says nothing for a duplicate application, docked or not', () => {
    applyToasts({ outcome: { duplicate: true } }, 'x');
    expect(notifySuccess).not.toHaveBeenCalled();
  });
});
