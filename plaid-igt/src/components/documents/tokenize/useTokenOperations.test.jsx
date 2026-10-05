import { describe, it, expect, vi } from 'vitest';
import { renderComponent } from '@ui/test/renderComponent.jsx';
import { DocumentProvider } from '../contexts/DocumentContext.jsx';
import { useTokenOperations } from './useTokenOperations.js';

// A Tokenize run that failed may still have written: its answer lost, or the
// service stopped partway. The document is read again before the lock goes,
// so what it stored shows. Not while the request is still out: its results
// are read when it finishes.

const requestService = vi.fn();
vi.mock('@ui/hooks/useServiceRequest.js', () => ({
  useServiceRequest: () => ({
    availableServices: [],
    isDiscovering: false,
    discoverServices: () => {},
    isProcessing: false,
    requestService,
    cancelRequest: () => {},
    hasServices: false,
    progressPercent: null,
    progressMessage: null,
  }),
}));
vi.mock('@ui/hooks/useServiceSpot.js', () => ({
  useServiceSpot: () => ({
    service: { serviceId: 'svc' },
    params: { errors: {}, coerced: () => ({}) },
  }),
}));
vi.mock('../../../domain/annotationLoss.js', () => ({
  countAnnotationLossForWord: () => 0,
  countSubWordAnnotationLoss: () => 0,
  countReTokenizeLoss: () => ({ annotations: 0, links: 0 }),
}));
vi.mock('@/utils/feedback', () => ({
  humanizeError: (e) => String(e),
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  notifyInfo: vi.fn(),
}));

const mount = async () => {
  const doc = {
    id: 'd1',
    document: { id: 'd1' },
    project: { id: 'p1' },
    layerInfo: {
      primaryTextLayer: { id: 'tl' },
      primaryTokenLayer: { id: 'wl' },
      sentenceTokenLayer: { id: 'sl' },
    },
    sentences: [],
    reload: vi.fn(async () => {}),
    _reload: vi.fn(async () => {}),
    sentenceSplitLoss: vi.fn(() => ({ annotations: 0, links: 0 })),
    splitSentence: vi.fn(async () => true),
    subscribe: () => () => {},
    getSnapshot: () => 0,
  };
  const lock = { release: vi.fn(), setStatus: () => {} };
  let ops;
  const Probe = () => {
    ops = useTokenOperations();
    return null;
  };
  const view = await renderComponent(
    <DocumentProvider value={{ doc, client: {}, acquireWriteLock: () => lock }}>
      <Probe />
    </DocumentProvider>,
  );
  return { doc, lock, view, ops: () => ops };
};

describe('a Tokenize run that failed', () => {
  it('reads the document again before its lock goes', async () => {
    requestService.mockReset();
    requestService.mockRejectedValue(Object.assign(new Error('lost'), { status: 0 }));
    const { doc, lock, view, ops } = await mount();
    await view.step(() => ops().handleTokenize());
    expect(doc.reload).toHaveBeenCalledTimes(1);
    expect(lock.release).toHaveBeenCalledTimes(1);
    expect(doc.reload.mock.invocationCallOrder[0]).toBeLessThan(
      lock.release.mock.invocationCallOrder[0],
    );
    await view.unmount();
  });

  it('does not while the request is still out', async () => {
    requestService.mockReset();
    requestService.mockRejectedValue(Object.assign(new Error('still out'), { pending: true }));
    const { doc, view, ops } = await mount();
    await view.step(() => ops().handleTokenize());
    expect(doc.reload).not.toHaveBeenCalled();
    await view.unmount();
  });
});

// A sentence split deletes the relations a layer rule keeps inside one
// sentence that the new break cuts, whichever app made them. It asks first
// when there are any, and splits at once when there are none.
describe('a sentence split', () => {
  it('splits at once when it deletes nothing', async () => {
    const { doc, view, ops } = await mount();
    await view.step(() => ops().splitSentence(8));
    expect(doc.sentenceSplitLoss).toHaveBeenCalledWith([8]);
    expect(doc.splitSentence).toHaveBeenCalledWith(8);
    expect(ops().pendingStructural).toBe(null);
    await view.unmount();
  });

  it('asks first when it deletes annotations, and splits on the answer', async () => {
    const { doc, view, ops } = await mount();
    doc.sentenceSplitLoss.mockReturnValue({ annotations: 2, links: 0 });
    await view.step(() => ops().splitSentence(8));
    expect(doc.splitSentence).not.toHaveBeenCalled();
    expect(ops().pendingStructural).toMatchObject({
      kind: 'sentence-split',
      payload: { charPos: 8 },
      annotations: 2,
    });
    await view.step(() => ops().cancelPendingStructural());
    expect(doc.splitSentence).not.toHaveBeenCalled();
    await view.step(() => ops().splitSentence(8));
    await view.step(() => ops().confirmPendingStructural());
    expect(doc.splitSentence).toHaveBeenCalledWith(8);
    expect(ops().pendingStructural).toBe(null);
    await view.unmount();
  });
});
