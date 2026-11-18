import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderComponent } from '@ui/test/renderComponent.jsx';
import { DocumentProvider } from '../contexts/DocumentContext.jsx';
import { AutoAnalyzeDialog } from './AutoAnalyzeDialog.jsx';

// REV-CP-3: a project with more links than the server counts at once. The
// built-in link step says what it did not link, and the run ends with what
// every step wrote, never as a failure.

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
    isBuiltin: true,
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
const notifyError = vi.fn();
vi.mock('@/utils/feedback', () => ({
  humanizeError: (e) => String(e),
  notifySuccess: (...a) => notifySuccess(...a),
  notifyError: (...a) => notifyError(...a),
  notifyInfo: vi.fn(),
  notifyWarning: vi.fn(),
}));

const mount = async () => {
  const doc = {
    id: 'd1',
    project: { id: 'p1', config: {} },
    vocabularies: { v1: { id: 'v1', items: [] } },
    layerInfo: {
      primaryTokenLayer: { id: 'wl' },
      morphemeTokenLayer: { id: 'ml' },
      sentenceTokenLayer: { id: 'sl' },
    },
    reload: vi.fn(async () => {}),
  };
  const lock = { release: vi.fn(), step: () => {}, report: () => {}, onProgress: () => {} };
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
  notifyError.mockReset();
});

describe('Auto-analyze on a link count the server cut', () => {
  // REV-CP-3: a link count the server cut ends the run as any other, with
  // what each step wrote.
  it('says the link step did not link on a cut count, after what the copy wrote', async () => {
    steps({ translate: false, copy: true, analyze: false, link: true });
    runBuiltinAnalysis
      .mockResolvedValueOnce({ ok: true, copied: 2, copiedWordIds: ['w1', 'w2'], linked: 0 })
      .mockResolvedValueOnce({ ok: true, linked: 0, linkCut: true });
    const { view } = await mount();
    await view.step(() => view.container.querySelector('[data-run]').click());
    await view.step(async () => {});
    expect(runBuiltinAnalysis).toHaveBeenCalledTimes(2);
    expect(notifyError).not.toHaveBeenCalled();
    expect(notifySuccess.mock.calls[0][0]).toBe(
      'Copied previous analyses onto 2 words, did not link words or morphemes: too many links in the project to count. Shown in violet until confirmed.',
    );
    await view.unmount();
  });
});
