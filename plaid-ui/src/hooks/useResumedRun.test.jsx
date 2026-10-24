import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderComponent } from '../test/renderComponent.jsx';

// A run rejoined after a reload takes the write lock again. Its banner clock
// must go on from when the run began, not start again at 0:00.

// Still running by default: the rejoin never settles within the test.
let attach = () => new Promise(() => {});
vi.mock('./useServiceRequest.js', () => ({
  useServiceRequest: () => ({
    attachToRequest: (...args) => attach(...args),
    cancelRequest: () => {},
    progressPercent: null,
    progressMessage: '',
  }),
}));

const notify = vi.hoisted(() => ({
  notifySuccess: vi.fn(),
  notifyWarning: vi.fn(),
  notifyInfo: vi.fn(),
}));
vi.mock('../lib/notify.js', () => notify);

const { useResumedRun } = await import('./useResumedRun.js');
const { writeRunRecord, readRunRecord } = await import('../domain/runRecord.js');

describe('useResumedRun', () => {
  beforeEach(() => {
    localStorage.clear();
    attach = () => new Promise(() => {});
    Object.values(notify).forEach((f) => f.mockClear());
  });

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

  // A run that finished while the page was away says what the page that
  // started it would have said: the app's words for the counts, by the run's
  // task (R18). A draft that failed every sentence must not be announced as
  // finished.
  const drafted = (result) =>
    result.drafted
      ? { level: 'success', title: `Drafted ${result.drafted}`, message: '' }
      : { level: 'warning', title: 'Nothing drafted', message: 'Sentence 1 failed.', sticky: true };
  const rejoin = async (
    result,
    { task = 'draft-graph', notices = { 'draft-graph': drafted } } = {},
  ) => {
    writeRunRecord('d1', { requestId: 'r1', projectId: 'p1', label: 'Draft', task });
    attach = () => Promise.resolve(result);
    const lock = { setStatus: vi.fn(), release: vi.fn() };
    const Probe = () => {
      useResumedRun({}, { id: 'd1', _reload: async () => {} }, () => lock, notices);
      return null;
    };
    const view = await renderComponent(<Probe />);
    await view.step(() => new Promise((r) => setTimeout(r, 0)));
    await view.unmount();
    expect(lock.release).toHaveBeenCalled();
  };

  it("words the counts as the task's notice does, a warning sticky", async () => {
    await rejoin({ drafted: 0, sentencesFailed: [{ sentence: 1, reason: 'x' }] });
    expect(notify.notifySuccess).not.toHaveBeenCalled();
    expect(notify.notifyWarning).toHaveBeenCalledWith('Sentence 1 failed.', 'Nothing drafted', {
      duration: Infinity,
    });
  });

  it("words a success as the task's notice does", async () => {
    await rejoin({ drafted: 3 });
    expect(notify.notifyWarning).not.toHaveBeenCalled();
    expect(notify.notifySuccess).toHaveBeenCalledWith(undefined, 'Drafted 3');
  });

  it('never shows a notice text the result carries', async () => {
    await rejoin(
      { notice: { level: 'success', title: 'Drafted', message: 'Drafted 3 sentences.' } },
      { notices: {} },
    );
    expect(notify.notifySuccess).toHaveBeenCalledWith('Draft finished.', 'Draft');
    expect(notify.notifySuccess).toHaveBeenCalledTimes(1);
  });

  it('says the run finished for a task the app words nothing for', async () => {
    await rejoin({ tokensCreated: 4 }, { task: 'tokenize' });
    expect(notify.notifySuccess).toHaveBeenCalledWith('Draft finished.', 'Draft');
  });

  it('says a stopped run stopped, whatever its counts', async () => {
    await rejoin({ stopped: true, drafted: 0 });
    expect(notify.notifyInfo).toHaveBeenCalled();
    expect(notify.notifyWarning).not.toHaveBeenCalled();
  });
});
