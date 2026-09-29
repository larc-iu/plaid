// One integration spot and its run. Every service run in every app wears this
// hook now, so the two things a caller depends on are asserted here: what it
// asks the service for, and what it does when there is no service to ask.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TASKS } from '@larc-iu/plaid-client';
import { renderComponent } from '../test/renderComponent.jsx';
import { useServiceRun } from './useServiceRun.js';

vi.mock('../lib/notify.js', () => ({ notifyError: vi.fn(), notifySuccess: vi.fn() }));

const SERVICE = {
  serviceId: 'svc',
  serviceName: 'Tokenizer',
  online: true,
  extras: { tasks: [TASKS.TOKENIZE], parameters: [] },
};

const BUILTIN = { name: 'rule-based', label: 'Rule-based' };

const lock = () => ({ setStatus: vi.fn(), release: vi.fn() });

const mount = async (over = {}) => {
  const requestService = vi.fn(async () => ({}));
  const acquireWriteLock = vi.fn(() => lock());
  const doc = { id: 'd1', reload: vi.fn(async () => {}) };
  const seen = { current: null };
  const Probe = () => {
    seen.current = useServiceRun({
      request: {
        availableServices: [SERVICE],
        requestService,
        cancelRequest: vi.fn(),
        progressPercent: null,
        progressMessage: '',
      },
      task: TASKS.TOKENIZE,
      storageId: 'run_test',
      builtins: [],
      project: null,
      projectId: 'p1',
      doc,
      acquireWriteLock,
      label: 'Tokenizing',
      args: { tokenLayerId: 'tl1' },
      ...over,
    });
    return null;
  };
  const view = await renderComponent(<Probe />);
  return { view, run: () => seen.current, requestService, acquireWriteLock, doc };
};

beforeEach(() => localStorage.clear());

describe('a run of one integration spot', () => {
  it('offers the service the spot is for, and is not running until it is asked', async () => {
    const { view, run } = await mount();
    expect(run().spot.selection).toBe('service:svc');
    expect(run().run.running).toBe(false);
    await view.unmount();
  });

  it('sends the document with the arguments its call site fixed', async () => {
    const { view, run, requestService, doc } = await mount();
    await view.step(() => run().start({ sentenceId: 's1' }));
    expect(requestService).toHaveBeenCalledWith(
      'p1',
      'd1',
      'svc',
      expect.objectContaining({ tokenLayerId: 'tl1', sentenceId: 's1', documentId: 'd1' }),
      expect.objectContaining({ onRequestId: expect.any(Function) }),
    );
    // The document is re-read once the service has written to it.
    expect(doc.reload).toHaveBeenCalled();
    await view.unmount();
  });

  // V8 H8-1: the service's batch landed and its answer was lost, the run
  // failed, and the screen went on showing the document without the tokens.
  it('reads the document again after a run that failed, which may have written', async () => {
    const requestService = vi.fn(async () => {
      throw new Error('The server did not answer.');
    });
    const { view, run, doc } = await mount({
      request: {
        availableServices: [SERVICE],
        requestService,
        cancelRequest: vi.fn(),
        progressPercent: null,
        progressMessage: '',
      },
    });
    await view.step(() => run().start());
    expect(doc.reload).toHaveBeenCalledTimes(1);
    await view.unmount();
  });

  it('does not read the document while the run is still out', async () => {
    const requestService = vi.fn(async () => {
      throw Object.assign(new Error('still running'), { pending: true });
    });
    const { view, run, doc } = await mount({
      request: {
        availableServices: [SERVICE],
        requestService,
        cancelRequest: vi.fn(),
        progressPercent: null,
        progressMessage: '',
      },
    });
    await view.step(() => run().start());
    expect(doc.reload).not.toHaveBeenCalled();
    await view.unmount();
  });

  // A spot whose chosen method is one of the app's own built-ins runs in the
  // browser, through the call site's own code. This hook takes no lock for it.
  it('takes no write lock when the chosen method is not a service', async () => {
    const { view, run, acquireWriteLock, requestService } = await mount({
      builtins: [BUILTIN],
      request: {
        availableServices: [],
        requestService: vi.fn(),
        cancelRequest: vi.fn(),
        progressPercent: null,
        progressMessage: '',
      },
    });
    expect(run().spot.selection).toBe('builtin:rule-based');
    await view.step(() => run().start());
    expect(acquireWriteLock).not.toHaveBeenCalled();
    expect(requestService).not.toHaveBeenCalled();
    await view.unmount();
  });
});
