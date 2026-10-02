import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderComponent } from '@ui/test/renderComponent.jsx';
import { DocumentProvider } from '../contexts/DocumentContext.jsx';
import { AutoAnalyzeDialog } from './AutoAnalyzeDialog.jsx';

// REV-SVC-3: the model step never re-analyzes the words the copy step wrote in
// the same run, Overwrite or not. The dialog names them to the service.

const requestService = vi.fn();
vi.mock('@ui/hooks/useServiceRequest.js', () => ({
  useServiceRequest: () => ({
    availableServices: [],
    isDiscovering: false,
    discoverServices: () => {},
    isProcessing: false,
    requestService,
    cancelRequest: async () => {},
    progressPercent: null,
    progressMessage: null,
  }),
}));
vi.mock('@ui/hooks/useServiceSpot.js', () => ({
  useServiceSpot: () => ({
    service: { serviceId: 'svc', serviceName: 'Svc' },
    params: { errors: {}, coerced: () => ({ overwrite: true }) },
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
vi.mock('@/domain/autoPass', () => ({ runBuiltinAnalysis: (...a) => runBuiltinAnalysis(...a) }));
const notifySuccess = vi.fn();
vi.mock('@/utils/feedback', () => ({
  humanizeError: (e) => String(e),
  notifySuccess: (...a) => notifySuccess(...a),
  notifyError: vi.fn(),
  notifyInfo: vi.fn(),
  notifyWarning: vi.fn(),
}));

const mount = async () => {
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
    _reload: vi.fn(async () => {}),
  };
  const lock = { release: vi.fn(), setStatus: () => {} };
  const view = await renderComponent(
    <DocumentProvider value={{ doc, client: {}, acquireWriteLock: () => lock, writeLock: null }}>
      <AutoAnalyzeDialog open onOpenChange={() => {}} doc={doc} />
    </DocumentProvider>,
  );
  return { view };
};

const steps = (s) => {
  try {
    localStorage.setItem('plaid_igt_auto_analyze_steps', JSON.stringify(s));
  } catch {
    /* ignore */
  }
};

beforeEach(() => {
  requestService.mockReset();
  runBuiltinAnalysis.mockReset();
  notifySuccess.mockReset();
});

describe('Auto-analyze after its copy step', () => {
  it('asks the model step to leave the copied words, with Overwrite on', async () => {
    steps({ translate: false, copy: true, analyze: true, link: false });
    runBuiltinAnalysis.mockResolvedValue({
      ok: true,
      copied: 2,
      copiedWordIds: ['w1', 'w2'],
      linked: 0,
    });
    requestService.mockResolvedValue({ wordsWritten: 3, skipped: { protected: 0 } });
    const { view } = await mount();
    await view.step(() => view.container.querySelector('[data-run]').click());
    await view.step(async () => {});
    expect(requestService).toHaveBeenCalledTimes(1);
    const params = requestService.mock.calls[0][3];
    expect(params.overwrite).toBe(true);
    expect(params.skipWordIds).toEqual(['w1', 'w2']);
    expect(notifySuccess.mock.calls[0][0]).toMatch(
      /^Copied previous analyses onto 2 words, proposed analyses for 3 words\./,
    );
    await view.unmount();
  });

  it('sends no list when the copy step is off', async () => {
    steps({ translate: false, copy: false, analyze: true, link: false });
    requestService.mockResolvedValue({ wordsWritten: 1, skipped: { protected: 0 } });
    const { view } = await mount();
    await view.step(() => view.container.querySelector('[data-run]').click());
    await view.step(async () => {});
    expect(requestService.mock.calls[0][3]).not.toHaveProperty('skipWordIds');
    await view.unmount();
  });
});
