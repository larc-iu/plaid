import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderComponent } from '@ui/test/renderComponent.jsx';
import { DocumentProvider } from '../contexts/DocumentContext.jsx';
import { AutoAnalyzeDialog } from './AutoAnalyzeDialog.jsx';

// A step whose service is offline (or, for linking, a project with no
// lexicon) shows unchecked, whatever was chosen last time. Before, it showed
// the remembered choice, checked and greyed out, though it would not run.

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
    service: null,
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
  };
  const lock = { release: vi.fn(), setStatus: () => {} };
  return renderComponent(
    <DocumentProvider value={{ doc, client: {}, acquireWriteLock: () => lock, writeLock: null }}>
      <AutoAnalyzeDialog open onOpenChange={() => {}} doc={doc} />
    </DocumentProvider>,
  );
};

beforeEach(() => {
  try {
    localStorage.setItem(
      'plaid_igt_auto_analyze_steps',
      JSON.stringify({ translate: true, copy: true, analyze: true, link: true }),
    );
  } catch {
    /* ignore */
  }
});

describe('an Auto-analyze step that cannot run', () => {
  it('shows unchecked though it was chosen last time', async () => {
    const view = await mount();
    const box = (label) => view.container.querySelector(`input[aria-label="${label}"]`);
    expect(box('Propose translations').checked).toBe(false);
    expect(box('Propose translations').disabled).toBe(true);
    expect(box('Copy previous analyses').checked).toBe(true);
    await view.unmount();
  });
});
