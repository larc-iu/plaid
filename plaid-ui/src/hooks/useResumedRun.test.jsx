import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderComponent } from '../test/renderComponent.jsx';

// A run rejoined after a reload takes the write lock again. Its banner clock
// must go on from when the run began, not start again at 0:00.

vi.mock('./useServiceRequest.js', () => ({
  useServiceRequest: () => ({
    // Still running: the rejoin never settles within the test.
    attachToRequest: () => new Promise(() => {}),
    cancelRequest: () => {},
    progressPercent: null,
    progressMessage: '',
  }),
}));

const { useResumedRun } = await import('./useResumedRun.js');
const { writeRunRecord, readRunRecord } = await import('../domain/runRecord.js');

describe('useResumedRun', () => {
  beforeEach(() => localStorage.clear());

  it('hands the lock the start the run record carries', async () => {
    // The run began five minutes before this page loaded.
    const startedAt = Date.now() - 5 * 60_000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(startedAt);
    writeRunRecord('d1', { requestId: 'r1', projectId: 'p1', label: 'Draft' });
    clock.mockRestore();
    expect(readRunRecord('d1').startedAt).toBe(startedAt);

    const lock = { setStatus: vi.fn(), release: vi.fn() };
    const acquire = vi.fn(() => lock);
    const Probe = () => {
      useResumedRun({}, { id: 'd1', _reload: async () => {} }, acquire);
      return null;
    };
    await renderComponent(<Probe />);

    expect(acquire).toHaveBeenCalledTimes(1);
    expect(acquire.mock.calls[0][0]).toBe('Draft');
    expect(acquire.mock.calls[0][1].startedAt).toBe(startedAt);
  });
});
