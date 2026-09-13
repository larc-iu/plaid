import { describe, it, expect, vi, beforeEach } from 'vitest';

import { renderComponent } from '../test/renderComponent.jsx';

// The toasts are what this hook is FOR: three of the bugs in its history were
// about which one it said, not about what it did.
vi.mock('../lib/notify.js', () => ({
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  notifyInfo: vi.fn(),
  notifyWarning: vi.fn(),
}));

const notify = await import('../lib/notify.js');
const { useServiceRequest } = await import('./useServiceRequest.js');

// A client whose one service request answers however the test says.
const fakeClient = (answer) => ({
  messages: {
    requestService: vi.fn(async () => {
      const result = answer();
      if (result instanceof Error) throw result;
      return result;
    }),
    discoverServices: vi.fn(async () => []),
    cancelServiceRequest: vi.fn(async () => {}),
    attachServiceRequest: vi.fn(async () => ({})),
  },
});

const mount = async (client) => {
  const seen = { current: null };
  const Probe = () => {
    seen.current = useServiceRequest(client);
    return null;
  };
  const r = await renderComponent(<Probe />);
  return { ...r, hook: () => seen.current };
};

const COPY = {
  successTitle: 'Tokenization complete',
  successMessage: 'The document was tokenized.',
  errorTitle: 'Tokenization failed',
  errorMessage: 'Could not tokenize the document.',
  stoppedTitle: 'Tokenization',
};

const run = async (r, options = COPY) => {
  let thrown = null;
  await r.step(async () => {
    try {
      await r.hook().requestService('p1', 'd1', 'svc', {}, options);
    } catch (err) {
      thrown = err;
    }
  });
  return thrown;
};

beforeEach(() => {
  for (const fn of Object.values(notify)) fn.mockClear();
});

describe('a run that was stopped', () => {
  it('is neither congratulated nor reported as a failure', async () => {
    // `stopped: true` comes back as an ordinary RESULT: the service was asked
    // and agreed. Three separate bugs came of reading it as a success, and one
    // of them titled it "Tokenization Complete. Stopped."
    const r = await mount(fakeClient(() => ({ stopped: true })));
    const thrown = await run(r);

    expect(thrown).toBe(null);
    expect(notify.notifySuccess).not.toHaveBeenCalled();
    expect(notify.notifyError).not.toHaveBeenCalled();
    expect(notify.notifyInfo).toHaveBeenCalledWith(
      'Stopped. What it had already written stays.',
      'Tokenization',
    );
    // Not 100%: nothing finished.
    expect(r.hook().progressPercent).toBe(null);
    expect(r.hook().progressMessage).toBe('Stopped.');
    await r.unmount();
  });

  it('lets a caller who can read the counts warn instead of congratulating', async () => {
    // A service reports a per-item failure in its counts rather than by failing
    // the request, so a run where every sentence failed still comes back a
    // success with its counts at zero.
    const r = await mount(fakeClient(() => ({ words: 0 })));
    await run(r, {
      ...COPY,
      notice: (result) =>
        result.words === 0
          ? { level: 'warning', title: 'Nothing to do', message: 'No word was written.' }
          : null,
    });

    expect(notify.notifySuccess).not.toHaveBeenCalled();
    expect(notify.notifyWarning).toHaveBeenCalledWith('No word was written.', 'Nothing to do');
    await r.unmount();
  });
});

describe('a run the client stopped waiting for', () => {
  it('says it is still going, rather than that it failed', async () => {
    // `pending` means the client gave up but the REQUEST did not: the service
    // goes on working and goes on writing. Calling that a failure is false, and
    // the caller keeps its run record so a reload can rejoin.
    const err = Object.assign(new Error('Timed out'), { pending: true });
    const r = await mount(fakeClient(() => err));
    const thrown = await run(r);

    expect(thrown).toBe(err);
    expect(notify.notifyError).not.toHaveBeenCalled();
    expect(notify.notifyWarning).toHaveBeenCalledWith(
      'Lost contact with the service. It is still running. Reload to pick it back up.',
      'Tokenization',
    );
    expect(r.hook().progressMessage).toBe('Lost contact with the service.');
    await r.unmount();
  });

  it('marks what it has already said, so a caller does not say it twice', async () => {
    // Auto-analyze toasted every service failure twice: its own guard was
    // `if (!isProcessing)`, read from a closure fixed at the render where Run
    // was pressed. The flag is the fix that does not depend on a closure.
    const err = new Error('The service broke');
    const r = await mount(fakeClient(() => err));
    const thrown = await run(r);

    expect(thrown).toBe(err);
    expect(err.reported).toBe(true);
    expect(notify.notifyError).toHaveBeenCalledWith('The service broke', 'Tokenization failed');
    await r.unmount();
  });
});

describe('what the hook hands back', () => {
  it('is over when it is over, whichever way it ended', async () => {
    const r = await mount(fakeClient(() => new Error('nope')));
    await run(r);
    expect(r.hook().isProcessing).toBe(false);
    await r.unmount();
  });

  it('carries no state nothing reads', async () => {
    // `processStatus`, `processError` and `clearProcessStatus` were an API that
    // nothing called, and `attachToRequest` left the status at 'started' on a
    // failure, which was invisible for exactly that reason.
    const r = await mount(fakeClient(() => ({})));
    expect(Object.keys(r.hook()).sort()).toEqual([
      'attachToRequest',
      'availableServices',
      'cancelRequest',
      'discoverServices',
      'hasServices',
      'isDiscovering',
      'isProcessing',
      'progressMessage',
      'progressPercent',
      'requestService',
    ]);
    await r.unmount();
  });
});
