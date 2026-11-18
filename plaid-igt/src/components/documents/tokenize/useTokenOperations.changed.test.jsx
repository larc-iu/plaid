import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderComponent } from '@ui/test/renderComponent.jsx';
import { DocumentProvider } from '../contexts/DocumentContext.jsx';
import { useTokenOperations } from './useTokenOperations.js';

// A Tokenize service run that stopped or dropped reads the document's version
// before and after, and says what it finds: the same rule as plaid-ud's Parse
// and Tokenize, from the shared hook (H2-9-4, H2-9-5, REV-G5-9).

const toasts = vi.hoisted(() => []);
vi.mock('@ui/lib/notify.js', () => ({
  notifySuccess: (message, title) => toasts.push({ kind: 'success', title, message }),
  notifyError: (message, title) => toasts.push({ kind: 'error', title, message }),
  notifyInfo: (message, title) => toasts.push({ kind: 'info', title, message }),
  notifyWarning: (message, title) => toasts.push({ kind: 'warning', title, message }),
}));
vi.mock('@ui/hooks/useServiceSpot.js', () => ({
  useServiceSpot: () => ({
    service: { serviceId: 'svc' },
    params: { errors: {}, coerced: () => ({}) },
  }),
}));
vi.mock('@/utils/feedback', () => ({
  humanizeError: (e) => String(e),
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  notifyInfo: vi.fn(),
}));

const mount = async ({ answer, versions }) => {
  const doc = {
    id: 'd1',
    version: 41,
    document: { id: 'd1' },
    project: { id: 'p1' },
    layerInfo: {
      primaryTextLayer: { id: 'tl' },
      primaryTokenLayer: { id: 'wl', tokens: [] },
      sentenceTokenLayer: { id: 'sl' },
    },
    sentences: [],
    reload: vi.fn(async () => {}),
    _reload: vi.fn(async () => {}),
    body: 'quickly',
    subscribe: () => () => {},
    getSnapshot: () => 0,
  };
  const client = {
    documents: {
      get: vi.fn(async () => ({ version: versions.length > 1 ? versions.shift() : versions[0] })),
    },
    messages: {
      discoverServices: vi.fn(async () => []),
      requestService: vi.fn(async () => {
        const result = await answer();
        if (result instanceof Error) throw result;
        return result;
      }),
    },
  };
  const lock = { release: vi.fn(), step: () => {}, report: () => {}, onProgress: () => {} };
  let ops;
  const Probe = () => {
    ops = useTokenOperations();
    return null;
  };
  const view = await renderComponent(
    <DocumentProvider value={{ doc, client, acquireWriteLock: () => lock }}>
      <Probe />
    </DocumentProvider>,
  );
  await view.step(() => ops.handleTokenize());
  await view.unmount();
};

beforeEach(() => {
  toasts.length = 0;
});

describe('a Tokenize service run that stopped', () => {
  it('says nothing was written when the document did not change', async () => {
    await mount({ answer: () => ({ stopped: true }), versions: [41, 41] });
    expect(toasts).toEqual([{ kind: 'info', title: 'Tokenize', message: 'Nothing was written.' }]);
  });

  it('says the document changed when it did', async () => {
    await mount({ answer: () => ({ stopped: true }), versions: [41, 42] });
    expect(toasts).toEqual([
      { kind: 'info', title: 'Tokenize', message: 'The document changed during the run.' },
    ]);
  });
});

describe('a Tokenize service run whose service dropped', () => {
  it('says to run it again when the document changed', async () => {
    await mount({ answer: () => new Error('Service disconnected'), versions: [41, 44] });
    expect(toasts).toEqual([
      {
        kind: 'error',
        title: 'Failed to tokenize',
        message:
          'Service disconnected. The document changed during the run. Run Tokenize again to finish.',
      },
    ]);
  });

  it('says nothing was written when it did not', async () => {
    await mount({ answer: () => new Error('Service disconnected'), versions: [41, 41] });
    expect(toasts).toEqual([
      {
        kind: 'error',
        title: 'Failed to tokenize',
        message: 'Service disconnected. Nothing was written.',
      },
    ]);
  });
});
