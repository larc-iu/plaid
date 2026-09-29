import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderComponent } from '@ui/test/renderComponent.jsx';
import { DocumentProvider } from '../contexts/DocumentContext.jsx';
import { AutoAnalyzeDialog } from './AutoAnalyzeDialog.jsx';

// A service step stopped partway has written what ran before the stop, and
// the request hook's toast says it is in the document. The document is read
// again before the lock goes, so it shows. Before, the run returned at once
// and the screen kept the document from before the run.

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
vi.mock('@/domain/autoPass', () => ({
  runBuiltinAnalysis: vi.fn(async () => ({ ok: true, copied: 0, linked: 0 })),
}));
vi.mock('@/utils/feedback', () => ({
  humanizeError: (e) => String(e),
  notifySuccess: vi.fn(),
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
  return { doc, lock, view };
};

beforeEach(() => {
  requestService.mockReset();
  try {
    localStorage.setItem(
      'plaid_igt_auto_analyze_steps',
      JSON.stringify({ translate: true, copy: false, analyze: false, link: false }),
    );
  } catch {
    /* ignore */
  }
});

describe('an Auto-analyze step that was stopped', () => {
  it('reads the document again before its lock goes', async () => {
    requestService.mockResolvedValue({ stopped: true });
    const { doc, lock, view } = await mount();
    await view.step(() => view.container.querySelector('[data-run]').click());
    await view.step(async () => {});
    expect(requestService).toHaveBeenCalledTimes(1);
    expect(doc._reload).toHaveBeenCalledTimes(1);
    expect(lock.release).toHaveBeenCalledTimes(1);
    expect(doc._reload.mock.invocationCallOrder[0]).toBeLessThan(
      lock.release.mock.invocationCallOrder[0],
    );
    await view.unmount();
  });
});
