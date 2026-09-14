import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderComponent } from '../test/renderComponent.jsx';

// The audit read and the snapshot read are the network, so the document model
// and the client are the seam. What is under test is the STATE MACHINE around
// them: an entry is selected the instant it is clicked and the snapshot shows
// only once its read lands, the live document is never touched, a read the
// reader has moved past is dropped, and a snapshot that cannot be read leaves
// the reader on the state they can actually see, with the rail agreeing.
vi.mock('../lib/notify.js', () => ({ notifyError: vi.fn() }));

const { notifyError } = await import('../lib/notify.js');
const { useHistoryView } = await import('./useHistoryView.js');

const ENTRY_A = { time: '2026-09-01T00:00:00Z' };
const ENTRY_B = { time: '2026-09-02T00:00:00Z' };

let view;
let api;
let doc;
let client;
let reload;
let onExpired;
let audit;

// A promise the test finishes when it chooses, so two snapshot reads can be in
// flight at once and land out of order.
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

// A stand-in document model. `atAsOf` hands back another one at the asked-for
// time, which is what both real ones do.
const makeDoc = (asOf = null) => ({
  id: 'doc-1',
  asOf,
  atAsOf: vi.fn((next) => Promise.resolve(makeDoc(next))),
});

// Each snapshot read parked until the test lands it.
const deferReads = () => {
  const pending = new Map();
  doc.atAsOf = vi.fn((time) => {
    const d = deferred();
    pending.set(time, d);
    return d.promise;
  });
  return pending;
};

const Probe = () => {
  api = useHistoryView({ documentId: 'doc-1', client, doc, reload, onExpired });
  return null;
};

const settle = () =>
  view.step(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

const mount = async () => {
  view = await renderComponent(<Probe />);
};

beforeEach(() => {
  notifyError.mockReset();
  audit = vi.fn(() => Promise.resolve([ENTRY_B, ENTRY_A]));
  client = { documents: { audit } };
  reload = vi.fn(() => Promise.resolve());
  onExpired = vi.fn();
  doc = makeDoc();
});

describe('the history view', () => {
  it('reads the entry list the first time the rail opens, and not again', async () => {
    await mount();
    await view.step(() => api.openHistory());
    await settle();
    expect(api.drawerOpen).toBe(true);
    expect(api.auditEntries).toEqual([ENTRY_B, ENTRY_A]);
    expect(audit).toHaveBeenCalledTimes(1);

    await view.step(() => api.closeHistory());
    await view.step(() => api.openHistory());
    await settle();
    expect(audit).toHaveBeenCalledTimes(1);
    await view.unmount();
  });

  it('selects the entry at once and shows the snapshot only once its read lands', async () => {
    const pending = deferReads();
    await mount();
    let selecting;
    await view.step(() => {
      selecting = api.selectEntry(ENTRY_A);
    });
    // Clicked: the banner is up and the editor read-only before anything has
    // been read, and what is on screen is still the live document.
    expect(api.selectedEntry).toBe(ENTRY_A);
    expect(api.loadingSnapshot).toBe(true);
    expect(api.isViewingHistorical).toBe(false);
    expect(api.snapshot).toBe(null);

    await view.step(async () => {
      pending.get(ENTRY_A.time).resolve(makeDoc(ENTRY_A.time));
      await selecting;
    });
    expect(doc.atAsOf).toHaveBeenCalledWith(ENTRY_A.time);
    expect(api.snapshot.asOf).toBe(ENTRY_A.time);
    expect(api.asOf).toBe(ENTRY_A.time);
    expect(api.isViewingHistorical).toBe(true);
    expect(api.loadingSnapshot).toBe(false);
    // The live document is where it was.
    expect(doc.asOf).toBe(null);
    await view.unmount();
  });

  it('drops a snapshot read the reader has already clicked past', async () => {
    // Two entries in quick succession, and the first read is the slower one.
    // The second click is what the reader is looking at, so the first read
    // has to be thrown away rather than shown on top of it.
    const pending = deferReads();
    await mount();
    // Not awaited: the reads are parked until the test lands them.
    await view.step(() => {
      api.selectEntry(ENTRY_A);
    });
    await view.step(() => {
      api.selectEntry(ENTRY_B);
    });
    await view.step(() => pending.get(ENTRY_B.time).resolve(makeDoc(ENTRY_B.time)));
    await settle();
    expect(api.asOf).toBe(ENTRY_B.time);
    expect(api.loadingSnapshot).toBe(false);

    await view.step(() => pending.get(ENTRY_A.time).resolve(makeDoc(ENTRY_A.time)));
    await settle();
    expect(api.asOf).toBe(ENTRY_B.time);
    expect(api.selectedEntry).toBe(ENTRY_B);
    await view.unmount();
  });

  it('a failed earlier read does not roll back the later selection', async () => {
    const pending = deferReads();
    await mount();
    // Not awaited: the reads are parked until the test lands them.
    await view.step(() => {
      api.selectEntry(ENTRY_A);
    });
    await view.step(() => {
      api.selectEntry(ENTRY_B);
    });
    await view.step(() => pending.get(ENTRY_B.time).resolve(makeDoc(ENTRY_B.time)));
    await settle();
    await view.step(() => pending.get(ENTRY_A.time).reject(new Error('gone')));
    await settle();
    expect(api.selectedEntry).toBe(ENTRY_B);
    expect(api.asOf).toBe(ENTRY_B.time);
    expect(notifyError).not.toHaveBeenCalled();
    await view.unmount();
  });

  it('returning to the live state cancels a read still out', async () => {
    // The reader who gives up on a slow entry stays where they went: a
    // snapshot they left must not open behind them.
    const pending = deferReads();
    await mount();
    await view.step(() => {
      api.selectEntry(ENTRY_A);
    });
    await view.step(() => api.selectEntry(null));
    expect(api.selectedEntry).toBe(null);
    expect(api.loadingSnapshot).toBe(false);

    await view.step(() => pending.get(ENTRY_A.time).resolve(makeDoc(ENTRY_A.time)));
    await settle();
    expect(api.isViewingHistorical).toBe(false);
    expect(api.selectedEntry).toBe(null);
    await view.unmount();
  });

  it('rolls the selection back to the snapshot on screen when a read fails', async () => {
    await mount();
    await view.step(() => api.selectEntry(ENTRY_A));
    await settle();
    expect(api.asOf).toBe(ENTRY_A.time);

    doc.atAsOf = vi.fn(() => Promise.reject(new Error('gone')));
    await view.step(() => api.selectEntry(ENTRY_B));
    await settle();
    expect(notifyError).toHaveBeenCalledTimes(1);
    // Back to the entry that is actually on screen, not the one that failed.
    expect(api.selectedEntry).toBe(ENTRY_A);
    expect(api.asOf).toBe(ENTRY_A.time);
    expect(api.loadingSnapshot).toBe(false);
    await view.unmount();
  });

  it('leaves the reader on the live document when the first snapshot will not load', async () => {
    await mount();
    const err = Object.assign(new Error('HTTP 503 Service Unavailable'), { status: 503 });
    doc.atAsOf = vi.fn(() => Promise.reject(err));
    await view.step(() => api.selectEntry(ENTRY_A));
    await settle();
    // The error OBJECT is the message, so the toast reads its status off it.
    expect(notifyError).toHaveBeenCalledWith(err, 'That snapshot could not be loaded');
    // The rail and the page agree again: both say live, which is what is up.
    expect(api.selectedEntry).toBe(null);
    expect(api.isViewingHistorical).toBe(false);
    await view.unmount();
  });

  it('the way back to the live document costs no read', async () => {
    await mount();
    await view.step(() => api.selectEntry(ENTRY_A));
    await settle();

    await view.step(() => api.selectEntry(null));
    await settle();
    expect(doc.atAsOf).toHaveBeenCalledTimes(1);
    expect(reload).not.toHaveBeenCalled();
    expect(api.asOf).toBe(null);
    expect(api.isViewingHistorical).toBe(false);
    expect(api.snapshot).toBe(null);
    await view.unmount();
  });

  it('hands an expired session from the entry list to the screen', async () => {
    audit.mockImplementation(() => Promise.reject(new Error('Not authenticated')));
    await mount();
    await view.step(() => api.openHistory());
    await settle();
    expect(onExpired).toHaveBeenCalled();
    expect(api.historyError).toBe('');
    await view.unmount();
  });

  it('hands an expired session from the snapshot read to the screen instead of toasting', async () => {
    await mount();
    doc.atAsOf = vi.fn(() =>
      Promise.reject(Object.assign(new Error('Unauthorized'), { status: 401 })),
    );
    await view.step(() => api.selectEntry(ENTRY_A));
    await settle();
    expect(onExpired).toHaveBeenCalled();
    expect(notifyError).not.toHaveBeenCalled();
    await view.unmount();
  });

  it('closing the rail on a snapshot returns to the live state', async () => {
    await mount();
    await view.step(() => api.openHistory());
    await view.step(() => api.selectEntry(ENTRY_A));
    await settle();

    await view.step(() => api.closeHistory());
    await settle();
    expect(api.drawerOpen).toBe(false);
    expect(api.selectedEntry).toBe(null);
    expect(api.asOf).toBe(null);
    await view.unmount();
  });

  it('a restore from a snapshot returns to live, reloads the document and re-reads the list', async () => {
    await mount();
    await view.step(() => api.selectEntry(ENTRY_A));
    await settle();

    await view.step(() => api.handleRestored());
    await settle();
    expect(api.selectedEntry).toBe(null);
    expect(api.isViewingHistorical).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledTimes(1);
    await view.unmount();
  });

  it('a restore from live re-reads the document in place', async () => {
    await mount();
    await view.step(() => api.handleRestored());
    await settle();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(doc.atAsOf).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledTimes(1);
    await view.unmount();
  });

  it('reads nothing before the document has arrived', async () => {
    doc = null;
    await mount();
    await view.step(() => api.selectEntry(ENTRY_A));
    await settle();
    expect(api.selectedEntry).toBe(ENTRY_A);
    expect(api.isViewingHistorical).toBe(false);
    expect(notifyError).not.toHaveBeenCalled();
    await view.unmount();
  });
});
