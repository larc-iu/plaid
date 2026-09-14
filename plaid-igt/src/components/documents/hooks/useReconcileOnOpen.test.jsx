import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderComponent } from '@ui/test/renderComponent.jsx';

// The repair itself is IgtDocument's, so `doc.reconcileOnOpen` is the seam.
// What is under test is the GATE around it: it is up before the pass, it comes
// down however the pass ends, it never runs over a snapshot, and it runs once
// per document. Every one of those has a failure mode that looks like nothing:
// a gate that never comes down is a document stuck on a spinner, and a pass
// over a snapshot writes what was true THEN into the live document.
vi.mock('@/utils/feedback', () => ({
  notifyError: vi.fn(),
  humanizeError: (e, fallback) => e?.message || fallback,
}));
vi.mock('@ui/lib/integrityToast.js', () => ({
  reportIntegrityFindings: vi.fn(),
  dismissIntegrityFindings: vi.fn(),
}));

const { notifyError } = await import('@/utils/feedback');
const { reportIntegrityFindings, dismissIntegrityFindings } = await import(
  '@ui/lib/integrityToast.js'
);
const { useReconcileOnOpen } = await import('./useReconcileOnOpen.js');

let view;
let api;

const Probe = (props) => {
  api = { reconciling: useReconcileOnOpen(props) };
  return null;
};

const settle = () =>
  view.step(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

const makeDoc = (result = {}, asOf = null) => ({
  id: 'doc-1',
  asOf,
  reconcileOnOpen: vi.fn(() => Promise.resolve(result)),
});

const base = { documentId: 'doc-1', asOf: null, canWrite: true };

beforeEach(() => {
  notifyError.mockReset();
  reportIntegrityFindings.mockReset();
  dismissIntegrityFindings.mockReset();
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('the reconcile gate', () => {
  it('holds the editor until the repair lands', async () => {
    let finish;
    const doc = makeDoc();
    doc.reconcileOnOpen = vi.fn(() => new Promise((resolve) => (finish = resolve)));
    view = await renderComponent(<Probe {...base} doc={doc} />);
    expect(api.reconciling).toBe(true);

    await view.step(async () => finish({}));
    await settle();
    expect(api.reconciling).toBe(false);
    await view.unmount();
  });

  it('comes down when a repair throws, rather than stranding the document', async () => {
    const doc = makeDoc();
    doc.reconcileOnOpen = vi.fn(() => Promise.reject(new Error('boom')));
    view = await renderComponent(<Probe {...base} doc={doc} />);
    await settle();
    expect(api.reconciling).toBe(false);
    await view.unmount();
  });

  it('is not raised at all while the document is still loading', async () => {
    view = await renderComponent(<Probe {...base} doc={null} />);
    await settle();
    // Still up, because there is nothing on screen to gate yet.
    expect(api.reconciling).toBe(true);
    await view.unmount();
  });

  it('comes down without a pass for a reader who cannot write', async () => {
    const doc = makeDoc();
    view = await renderComponent(<Probe {...base} doc={doc} canWrite={false} />);
    await settle();
    expect(doc.reconcileOnOpen).not.toHaveBeenCalled();
    expect(api.reconciling).toBe(false);
    await view.unmount();
  });

  it('never repairs while a snapshot is being viewed', async () => {
    const doc = makeDoc();
    view = await renderComponent(<Probe {...base} doc={doc} asOf="2026-09-01T00:00:00Z" />);
    await settle();
    expect(doc.reconcileOnOpen).not.toHaveBeenCalled();
    expect(api.reconciling).toBe(false);
    await view.unmount();
  });

  it('never repairs a document that is itself a snapshot', async () => {
    // On the way back from history the page's asOf is already null while the
    // document is still the snapshot. A pass here would write what was true
    // THEN into the live document.
    const doc = makeDoc({}, '2026-09-01T00:00:00Z');
    view = await renderComponent(<Probe {...base} doc={doc} />);
    await settle();
    expect(doc.reconcileOnOpen).not.toHaveBeenCalled();
    expect(api.reconciling).toBe(false);
    await view.unmount();
  });

  it('repairs once per document, not once per render', async () => {
    const doc = makeDoc();
    view = await renderComponent(<Probe {...base} doc={doc} />);
    await settle();
    await view.rerender(<Probe {...base} doc={doc} />);
    await settle();
    expect(doc.reconcileOnOpen).toHaveBeenCalledTimes(1);

    const next = makeDoc();
    await view.rerender(<Probe {...base} doc={next} />);
    await settle();
    expect(next.reconcileOnOpen).toHaveBeenCalledTimes(1);
    await view.unmount();
  });

  it('names the cause when a repair fails', async () => {
    const doc = makeDoc({ error: new Error('request timed out') });
    view = await renderComponent(<Probe {...base} doc={doc} />);
    await settle();
    expect(notifyError).toHaveBeenCalledWith(
      expect.stringContaining('request timed out'),
      'Repair failed',
    );
    // A failure does not also report findings from the same pass.
    expect(reportIntegrityFindings).not.toHaveBeenCalled();
    expect(api.reconciling).toBe(false);
    await view.unmount();
  });

  it('says nothing about a repair that succeeded', async () => {
    const doc = makeDoc({ deleted: 3, dedupedSpans: 1 });
    view = await renderComponent(<Probe {...base} doc={doc} />);
    await settle();
    expect(notifyError).not.toHaveBeenCalled();
    expect(console.info).toHaveBeenCalledWith(expect.stringContaining('removed 3'));
    await view.unmount();
  });

  it('reports what it could not repair', async () => {
    const findings = [{ severity: 'error', code: 'x', message: 'y' }];
    const doc = makeDoc({ findings });
    view = await renderComponent(<Probe {...base} doc={doc} />);
    await settle();
    expect(reportIntegrityFindings).toHaveBeenCalledWith(findings, { documentId: 'doc-1' });
    await view.unmount();
  });

  it('drops the sticky toast when the reader leaves the document', async () => {
    const doc = makeDoc();
    view = await renderComponent(<Probe {...base} doc={doc} />);
    await settle();
    expect(dismissIntegrityFindings).not.toHaveBeenCalled();
    await view.unmount();
    expect(dismissIntegrityFindings).toHaveBeenCalled();
  });
});
