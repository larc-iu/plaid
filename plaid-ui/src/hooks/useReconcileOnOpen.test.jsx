import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StrictMode } from 'react';
import { renderComponent } from '../test/renderComponent.jsx';

// The repair itself is the document's, so `doc.reconcileOnOpen` is the seam.
// What is under test is the GATE around it: it is up before the pass, it comes
// down however the pass ends, it never runs over a snapshot, and it runs once
// per document. Every one of those has a failure mode that looks like nothing:
// a gate that never comes down is a document stuck on a spinner, and a pass
// over a snapshot writes what was true THEN into the live document.
vi.mock('../lib/notify.js', () => ({ notifyError: vi.fn() }));
vi.mock('../lib/integrityToast.js', () => ({ reportIntegrityFindings: vi.fn() }));

const { notifyError } = await import('../lib/notify.js');
const { reportIntegrityFindings } = await import('../lib/integrityToast.js');
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

// A stand-in document: the repair resolves to `result`, and the description
// of a repair is the document's own line, as it is on the real ones.
const makeDoc = (result = {}, asOf = null) => ({
  id: 'doc-1',
  asOf,
  reconcileOnOpen: vi.fn(() => Promise.resolve(result)),
  describeReconcile: ({ deleted = 0 } = {}) => (deleted ? `Reconcile: removed ${deleted}` : null),
});

// A document whose repair the test finishes when it chooses, so two passes can
// be in flight at once and land out of order.
const pendingDoc = (id) => {
  let finish;
  return {
    doc: {
      id,
      asOf: null,
      reconcileOnOpen: vi.fn(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      ),
      describeReconcile: () => null,
    },
    finish: (result) => finish(result),
  };
};

const base = { asOf: null, canWrite: true };

beforeEach(() => {
  notifyError.mockReset();
  reportIntegrityFindings.mockReset();
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
    const doc = makeDoc({ error: new Error('the span layer is gone') });
    view = await renderComponent(<Probe {...base} doc={doc} />);
    await settle();
    expect(notifyError).toHaveBeenCalledWith(
      expect.stringContaining('the span layer is gone'),
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

  // The two tests below read what the gate did WHILE a repair was in flight.
  // Reading only the end state cannot tell a cancellation guard from its
  // absence: without one the editor still settles open on the right document,
  // and the only trace of the pass that should have been thrown away is a
  // moment of the wrong screen and a findings toast about a document nobody is
  // looking at.
  it('neither reports nor lowers the gate for a pass the reader has left behind', async () => {
    const first = pendingDoc('doc-1');
    const second = pendingDoc('doc-2');
    view = await renderComponent(<Probe {...base} doc={first.doc} />);
    await view.rerender(<Probe {...base} doc={second.doc} />);

    // The first document's repair lands after the reader has moved on.
    await view.step(() => first.finish({ findings: [{ severity: 'error', code: 'stale' }] }));
    await settle();
    expect(reportIntegrityFindings).not.toHaveBeenCalled();
    // Still up. The pass that replaced it is running, and an editor that opens
    // between the two is an editable document mid-repair.
    expect(api.reconciling).toBe(true);

    await view.step(() => second.finish({ findings: [{ severity: 'error', code: 'live' }] }));
    await settle();
    expect(reportIntegrityFindings).toHaveBeenCalledTimes(1);
    expect(reportIntegrityFindings).toHaveBeenCalledWith([{ severity: 'error', code: 'live' }], {
      documentId: 'doc-2',
    });
    expect(api.reconciling).toBe(false);
    await view.unmount();
  });

  it('runs again after a cancelled pass, rather than waiting on it forever', async () => {
    // StrictMode's double-invoke is this exact sequence: the first pass is set
    // up, cancelled, and set up again on the same document. A cancelled pass
    // reports nothing and leaves the gate up, so if the second setup treated
    // the document as already repaired the editor would sit on a spinner with
    // no repair in flight, and the findings would never be shown.
    const { doc, finish } = pendingDoc('doc-1');
    view = await renderComponent(
      <StrictMode>
        <Probe {...base} doc={doc} />
      </StrictMode>,
    );
    expect(doc.reconcileOnOpen).toHaveBeenCalledTimes(2);

    await view.step(() => finish({ findings: [{ severity: 'error', code: 'live' }] }));
    await settle();
    expect(reportIntegrityFindings).toHaveBeenCalledTimes(1);
    expect(api.reconciling).toBe(false);
    await view.unmount();
  });

  it('calls onRepaired once the pass has ended and before the gate comes down', async () => {
    const seen = [];
    const { doc, finish } = pendingDoc('doc-1');
    const onRepaired = () => seen.push(api.reconciling);
    view = await renderComponent(<Probe {...base} doc={doc} onRepaired={onRepaired} />);
    expect(seen).toEqual([]);

    await view.step(() => finish({}));
    await settle();
    // Called while the gate was still up: strict mode is on before any edit.
    expect(seen).toEqual([true]);
    expect(api.reconciling).toBe(false);
    await view.unmount();
  });

  it('calls onRepaired on a path with nothing to repair', async () => {
    const onRepaired = vi.fn();
    view = await renderComponent(
      <Probe {...base} doc={makeDoc()} canWrite={false} onRepaired={onRepaired} />,
    );
    await settle();
    expect(onRepaired).toHaveBeenCalledTimes(1);
    expect(api.reconciling).toBe(false);
    await view.unmount();
  });
});
