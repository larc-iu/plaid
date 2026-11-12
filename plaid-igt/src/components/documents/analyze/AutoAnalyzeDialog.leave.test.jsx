import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderComponent } from '@ui/test/renderComponent.jsx';
import { useWriteLock } from '@ui/hooks/useWriteLock.js';
import { readRunRecord, __resetUnloadingForTests } from '@ui/domain/runRecord.js';
import { DocumentProvider } from '../contexts/DocumentContext.jsx';
import { AutoAnalyzeDialog } from './AutoAnalyzeDialog.jsx';

// Leaving the document inside the app while Auto-analyze runs (Luke,
// 2026-11-12: "Stop after the current step, and warn"). The document's page
// owns the write lock, and its unmount used to stop nothing: the run went on
// through every remaining step with no banner anywhere, and a page that came
// back rejoined only the step in flight and then said the rest did not run
// while they might be running. Now the run stops after the step in flight.

const requestService = vi.fn();
vi.mock('@ui/hooks/useServiceRequest.js', () => ({
  useServiceRequest: () => ({
    availableServices: [],
    isDiscovering: false,
    discoverServices: () => {},
    requestService,
    cancelRequest: async () => {},
  }),
}));
vi.mock('@ui/hooks/useServiceSpot.js', () => ({
  useServiceSpot: () => ({
    service: { serviceId: 'svc', serviceName: 'Svc' },
    params: { errors: {}, coerced: () => ({}) },
  }),
}));
vi.mock('@ui/components/services/ServiceRunDialog.jsx', () => ({
  ServiceRunDialog: ({ onRun, children }) => (
    <div>
      <button data-run onClick={onRun}>
        Run
      </button>
      {children}
    </div>
  ),
}));
vi.mock('@ui/components/services/ServiceMethodRow.jsx', () => ({
  ServiceMethodRow: () => null,
}));
const runBuiltinAnalysis = vi.fn();
vi.mock('@/domain/autoPass', () => ({
  runBuiltinAnalysis: (...args) => runBuiltinAnalysis(...args),
}));
vi.mock('@/utils/feedback', () => ({
  humanizeError: (e) => String(e),
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  notifyInfo: vi.fn(),
  notifyWarning: vi.fn(),
}));

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};
const tick = () => new Promise((r) => setTimeout(r, 0));

const doc = {
  id: 'd1',
  project: { id: 'p1', config: {} },
  vocabularies: {},
  layerInfo: {
    primaryTokenLayer: { id: 'wl' },
    morphemeTokenLayer: { id: 'ml' },
    sentenceTokenLayer: { id: 'sl' },
  },
  reload: vi.fn(async () => {}),
};

// The document's page: it owns the write lock, as the editor shell does.
const Page = () => {
  const lock = useWriteLock();
  return (
    <DocumentProvider
      value={{ doc, client: {}, acquireWriteLock: lock.acquire, writeLock: lock.held }}
    >
      <AutoAnalyzeDialog open onOpenChange={() => {}} doc={doc} />
    </DocumentProvider>
  );
};

const steps = (on) => {
  localStorage.setItem(
    'plaid_igt_auto_analyze_steps',
    JSON.stringify({ translate: false, copy: false, analyze: false, link: false, ...on }),
  );
};

beforeEach(() => {
  localStorage.clear();
  __resetUnloadingForTests();
  requestService.mockReset();
  runBuiltinAnalysis.mockReset();
  vi.clearAllMocks();
  doc.reload.mockClear();
});

describe('Auto-analyze when its document is left', () => {
  it('stops a built-in step at its next checkpoint, and starts no later step', async () => {
    steps({ copy: true, analyze: true });
    const gate = deferred();
    runBuiltinAnalysis.mockImplementation(async (_doc, { shouldStop }) => {
      await gate.promise;
      return shouldStop() ? { ok: true, stopped: true } : { ok: true, copied: 0 };
    });
    requestService.mockResolvedValue({});
    const view = await renderComponent(<Page />);
    await view.step(() => view.container.querySelector('[data-run]').click());
    expect(runBuiltinAnalysis).toHaveBeenCalledTimes(1);

    await view.unmount();
    await tick();
    gate.resolve();
    await tick();
    await tick();
    expect(requestService).not.toHaveBeenCalled();
    const { notifyInfo } = await import('@/utils/feedback');
    expect(notifyInfo).toHaveBeenCalledWith(
      'Stopped partway. What ran before the stop is in the document.',
      'Auto-analyze',
    );
  });

  it('leaves a service step to finish, keeps its record and starts no later step', async () => {
    steps({ translate: true, copy: true, link: false });
    const answer = deferred();
    requestService.mockImplementation((_p, _d, _s, _args, { onRequestId }) => {
      onRequestId('req-1');
      return answer.promise;
    });
    runBuiltinAnalysis.mockResolvedValue({ ok: true, copied: 0 });
    const view = await renderComponent(<Page />);
    await view.step(() => view.container.querySelector('[data-run]').click());
    expect(requestService).toHaveBeenCalledTimes(1);

    await view.unmount();
    await tick();
    answer.resolve({ sentencesWritten: 3 });
    await tick();
    await tick();
    // Not cancelled, not read again here, and nothing after it.
    expect(runBuiltinAnalysis).not.toHaveBeenCalled();
    expect(doc.reload).not.toHaveBeenCalled();
    // The page that comes back rejoins it, and names what did not run.
    expect(readRunRecord('d1')).toMatchObject({
      requestId: 'req-1',
      label: 'Auto-analyze',
      stepsAfter: ['Copy previous analyses'],
    });
  });

  // REV-RUN-1: the page that was left said the step out loud wherever the
  // person had gone ("Translation complete" on the documents list), and the
  // page they came back to said it again.
  it.each([
    ['answers', (answer) => answer.resolve({ sentencesWritten: 3 })],
    ['fails', (answer) => answer.reject(Object.assign(new Error('broke'), { reported: true }))],
  ])('says nothing on the page that left when a service step %s', async (_, settle) => {
    steps({ translate: true, copy: true });
    let answer;
    let options;
    requestService.mockImplementation((_p, _d, _s, _args, opts) => {
      options = opts;
      opts.onRequestId('req-1');
      answer = {};
      return new Promise((resolve, reject) => Object.assign(answer, { resolve, reject }));
    });
    const view = await renderComponent(<Page />);
    await view.step(() => view.container.querySelector('[data-run]').click());
    // The request's own toasts, read when it settles.
    expect(options.quiet()).toBe(false);

    await view.unmount();
    await tick();
    expect(options.quiet()).toBe(true);
    settle(answer);
    await tick();
    await tick();
    const feedback = await import('@/utils/feedback');
    for (const say of ['notifySuccess', 'notifyError', 'notifyInfo', 'notifyWarning']) {
      expect(feedback[say]).not.toHaveBeenCalled();
    }
    // The page that comes back says it, by the step's name.
    expect(readRunRecord('d1')).toMatchObject({
      requestId: 'req-1',
      step: 'Propose translations',
      stepsAfter: ['Copy previous analyses'],
    });
  });

  it('goes on through every step while its page stays, whatever tab is shown', async () => {
    steps({ translate: true, copy: true });
    requestService.mockImplementation(async (_p, _d, _s, _args, { onRequestId }) => {
      onRequestId('req-1');
      return {};
    });
    runBuiltinAnalysis.mockResolvedValue({ ok: true, copied: 0 });
    const view = await renderComponent(<Page />);
    await view.step(() => view.container.querySelector('[data-run]').click());
    await view.step(tick);
    expect(requestService).toHaveBeenCalledTimes(1);
    expect(runBuiltinAnalysis).toHaveBeenCalledTimes(1);
    expect(readRunRecord('d1')).toBe(null);
    await view.unmount();
  });
});
