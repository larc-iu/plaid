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
const { useReconcileOnOpen, REPAIR_TIMEOUT_MS, REPAIR_MS_PER_TOKEN } = await import(
  './useReconcileOnOpen.js'
);

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
      'Failed to repair the document',
    );
    // A failure does not also report findings from the same pass.
    expect(reportIntegrityFindings).not.toHaveBeenCalled();
    expect(api.reconciling).toBe(false);
    await view.unmount();
  });

  it('says the repaired document could not be read again, not that the repair failed', async () => {
    const doc = makeDoc({
      deleted: 3,
      findings: [],
      refreshError: Object.assign(new Error('Failed to fetch'), { status: 0 }),
    });
    view = await renderComponent(<Probe {...base} doc={doc} />);
    await settle();
    expect(notifyError).toHaveBeenCalledTimes(1);
    expect(notifyError).toHaveBeenCalledWith(
      expect.stringContaining('Try reloading.'),
      'Failed to reload the repaired document',
    );
    expect(console.info).toHaveBeenCalledWith(expect.stringContaining('removed 3'));
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

  it('enters strict mode before the repair writes, so its writes carry the version it was planned from', async () => {
    const seen = [];
    const { doc, finish } = pendingDoc('doc-1');
    const enterStrictMode = vi.fn(() => seen.push(doc.reconcileOnOpen.mock.calls.length));
    view = await renderComponent(<Probe {...base} doc={doc} enterStrictMode={enterStrictMode} />);
    // Entered before the pass started, not after it landed.
    expect(seen[0]).toBe(0);
    expect(doc.reconcileOnOpen).toHaveBeenCalledTimes(1);

    await view.step(() => finish({}));
    await settle();
    expect(api.reconciling).toBe(false);
    await view.unmount();
  });

  it('enters strict mode on a path with nothing to repair', async () => {
    const enterStrictMode = vi.fn();
    view = await renderComponent(
      <Probe {...base} doc={makeDoc()} canWrite={false} enterStrictMode={enterStrictMode} />,
    );
    await settle();
    expect(enterStrictMode).toHaveBeenCalled();
    expect(api.reconciling).toBe(false);
    await view.unmount();
  });

  it('re-reads and plans the repair again once after a conflict, and says nothing when that lands', async () => {
    const conflict = Object.assign(new Error('HTTP 409 Document version mismatch'), {
      status: 409,
    });
    const doc = makeDoc();
    doc.reload = vi.fn(() => Promise.resolve());
    doc.reconcileOnOpen = vi
      .fn()
      .mockResolvedValueOnce({ findings: [], error: conflict })
      .mockResolvedValueOnce({ findings: [], deleted: 1 });
    view = await renderComponent(<Probe {...base} doc={doc} />);
    await settle();
    await settle();
    expect(doc.reload).toHaveBeenCalledTimes(1);
    expect(doc.reconcileOnOpen).toHaveBeenCalledTimes(2);
    expect(notifyError).not.toHaveBeenCalled();
    expect(api.reconciling).toBe(false);
    await view.unmount();
  });

  it('says the document changed while it was checked when the second plan is refused too', async () => {
    const conflict = Object.assign(new Error('HTTP 409 Document version mismatch'), {
      status: 409,
    });
    const doc = makeDoc({ findings: [], error: conflict });
    doc.reload = vi.fn(() => Promise.resolve());
    const onFailed = vi.fn();
    view = await renderComponent(<Probe {...base} doc={doc} onFailed={onFailed} />);
    await settle();
    await settle();
    expect(doc.reconcileOnOpen).toHaveBeenCalledTimes(2);
    expect(notifyError).toHaveBeenCalledTimes(1);
    expect(notifyError).toHaveBeenCalledWith(
      'The document changed while it was being checked. Reload to check it again.',
      'Failed to repair the document',
    );
    expect(onFailed).toHaveBeenCalledWith(conflict);
    expect(api.reconciling).toBe(false);
    await view.unmount();
  });

  it('does not re-plan a repair that failed for another reason', async () => {
    const doc = makeDoc({ findings: [], error: new Error('HTTP 400 Token is not contained') });
    doc.reload = vi.fn(() => Promise.resolve());
    view = await renderComponent(<Probe {...base} doc={doc} />);
    await settle();
    expect(doc.reload).not.toHaveBeenCalled();
    expect(doc.reconcileOnOpen).toHaveBeenCalledTimes(1);
    // A raw server message ends its sentence before the instruction.
    expect(notifyError).toHaveBeenCalledWith(
      'Token is not contained. Reload to check the document again.',
      'Failed to repair the document',
    );
    await view.unmount();
  });

  it('says a repair that timed out is to be checked again, not a change that may be lost', async () => {
    const timedOut = Object.assign(new Error('The operation was aborted due to timeout'), {
      status: 0,
      method: 'POST',
      url: 'http://host/api/v1/batch',
    });
    const doc = makeDoc({ findings: [], error: timedOut });
    view = await renderComponent(<Probe {...base} doc={doc} />);
    await settle();
    expect(notifyError).toHaveBeenCalledWith(
      'The server did not answer in time. Reload to check the document again.',
      'Failed to repair the document',
    );
    await view.unmount();
  });

  it('says a repair whose answer was lost on a dropped connection that it was lost', async () => {
    const dropped = Object.assign(
      new Error('Network error: Failed to fetch at http://host/api/v1/batch'),
      {
        status: 0,
        method: 'POST',
        url: 'http://host/api/v1/batch',
      },
    );
    const doc = makeDoc({ findings: [], error: dropped });
    view = await renderComponent(<Probe {...base} doc={doc} />);
    await settle();
    expect(notifyError).toHaveBeenCalledWith(
      "The server's answer was lost. Reload to check the document again.",
      'Failed to repair the document',
    );
    await view.unmount();
  });

  it('gives a big document more time, by the tokens it holds', async () => {
    const client = { batchTimeout: 180000 };
    let during;
    const tokens = (n) => Array.from({ length: n }, (_, i) => ({ id: `t${i}` }));
    const doc = makeDoc({});
    doc.client = client;
    doc.raw = {
      textLayers: [{ tokenLayers: [{ tokens: tokens(40000) }, { tokens: tokens(2000) }] }],
    };
    const inner = doc.reconcileOnOpen;
    doc.reconcileOnOpen = vi.fn(() => {
      during = client.batchTimeout;
      return inner();
    });
    view = await renderComponent(<Probe {...base} doc={doc} />);
    await settle();
    expect(during).toBe(REPAIR_TIMEOUT_MS + 42000 * REPAIR_MS_PER_TOKEN);
    // A 40,000-word first open took the server about 47 s.
    expect(during).toBeGreaterThan(60000);
    expect(client.batchTimeout).toBe(180000);
    await view.unmount();
  });

  it('gives each request of the repair a short timeout, and puts the client back after', async () => {
    const client = { batchTimeout: 180000 };
    let during;
    const { doc, finish } = pendingDoc('doc-1');
    doc.client = client;
    // Concurrent callers share one pass, as DocumentModel's do.
    let pass = null;
    const inner = doc.reconcileOnOpen;
    doc.reconcileOnOpen = vi.fn(() => {
      during = client.batchTimeout;
      pass ??= inner();
      return pass;
    });
    view = await renderComponent(
      <StrictMode>
        <Probe {...base} doc={doc} />
      </StrictMode>,
    );
    expect(during).toBe(REPAIR_TIMEOUT_MS);
    expect(REPAIR_TIMEOUT_MS).toBeLessThanOrEqual(30000);

    await view.step(() => finish({}));
    await settle();
    // Both runs of StrictMode's double invoke have ended.
    expect(client.batchTimeout).toBe(180000);
    expect(api.reconciling).toBe(false);
    await view.unmount();
  });
});
