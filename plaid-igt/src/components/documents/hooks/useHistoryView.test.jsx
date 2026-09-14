import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useState } from 'react';
import { renderComponent } from '@ui/test/renderComponent.jsx';

// The audit read and the snapshot read are the network, so the client is the
// seam. What is under test is the STATE MACHINE around them: `asOf` is the only
// thing that drives time travel, the document is swapped rather than blanked,
// and a snapshot that cannot be read has to leave the reader on the state they
// can actually see, with the rail agreeing.
vi.mock('@/utils/feedback', () => ({
  notifyError: vi.fn(),
  humanizeError: (e, fallback) => e?.message || fallback,
}));

const { notifyError } = await import('@/utils/feedback');
const { useHistoryView } = await import('./useHistoryView.js');

const ENTRY_A = { time: '2026-09-01T00:00:00Z' };
const ENTRY_B = { time: '2026-09-02T00:00:00Z' };

let view;
let api;
let doc;
let client;
let onExpired;
let audit;

// A stand-in IgtDocument. `atAsOf` hands back another one at the asked-for
// snapshot, which is what the real one does.
const makeDoc = (asOf = null) => ({
  id: 'doc-1',
  asOf,
  onError: () => {},
  atAsOf: vi.fn(function (next) {
    return Promise.resolve(makeDoc(next));
  }),
  reload: vi.fn(() => Promise.resolve()),
});

const Probe = () => {
  const [current, setDoc] = useState(doc);
  doc = current;
  api = useHistoryView({
    documentId: 'doc-1',
    client,
    doc: current,
    setDoc,
    onExpired,
  });
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

  it('swaps the document for the snapshot an entry names', async () => {
    await mount();
    const live = doc;
    await view.step(() => api.selectEntry(ENTRY_A));
    await settle();
    expect(live.atAsOf).toHaveBeenCalledWith(ENTRY_A.time);
    expect(api.asOf).toBe(ENTRY_A.time);
    expect(api.isViewingHistorical).toBe(true);
    expect(api.selectedEntry).toBe(ENTRY_A);
    // Swapped, never blanked: there is a document on screen the whole way.
    expect(doc.asOf).toBe(ENTRY_A.time);
    await view.unmount();
  });

  it('carries the error handler across the swap', async () => {
    await mount();
    const onError = () => {};
    doc.onError = onError;
    await view.step(() => api.selectEntry(ENTRY_A));
    await settle();
    expect(doc.onError).toBe(onError);
    await view.unmount();
  });

  it('goes back to the live document when nothing is selected', async () => {
    await mount();
    await view.step(() => api.selectEntry(ENTRY_A));
    await settle();

    const snapshot = doc;
    await view.step(() => api.selectEntry(null));
    await settle();
    expect(snapshot.atAsOf).toHaveBeenCalledWith(null);
    expect(api.asOf).toBe(null);
    expect(api.isViewingHistorical).toBe(false);
    expect(doc.asOf).toBe(null);
    await view.unmount();
  });

  it('leaves the reader on what they can see when a snapshot will not load', async () => {
    await mount();
    doc.atAsOf = vi.fn(() => Promise.reject(new Error('gone')));
    const live = doc;
    await view.step(() => api.selectEntry(ENTRY_A));
    await settle();
    expect(notifyError).toHaveBeenCalled();
    // The rail and the page agree again: both say live, which is what is up.
    expect(api.asOf).toBe(null);
    expect(api.selectedEntry).toBe(null);
    expect(doc).toBe(live);
    await view.unmount();
  });

  it('hands an expired session to the screen instead of toasting', async () => {
    await mount();
    doc.atAsOf = vi.fn(() => Promise.reject(new Error('Not authenticated')));
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

  it('a restore from a snapshot returns to live and re-reads the list', async () => {
    await mount();
    await view.step(() => api.selectEntry(ENTRY_A));
    await settle();
    const snapshot = doc;

    await view.step(() => api.handleRestored());
    await settle();
    expect(api.asOf).toBe(null);
    expect(api.selectedEntry).toBe(null);
    expect(snapshot.reload).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledTimes(1);
    await view.unmount();
  });

  it('a restore from live re-reads the document in place', async () => {
    await mount();
    const live = doc;
    await view.step(() => api.handleRestored());
    await settle();
    // In place: a fresh IgtDocument would rebuild the grid and throw away the
    // reader's position in a document they have just changed.
    expect(live.reload).toHaveBeenCalledTimes(1);
    expect(live.atAsOf).not.toHaveBeenCalled();
    expect(doc).toBe(live);
    expect(audit).toHaveBeenCalledTimes(1);
    await view.unmount();
  });

  it('reads nothing before the document has arrived', async () => {
    doc = null;
    await mount();
    await view.step(() => api.selectEntry(ENTRY_A));
    await settle();
    expect(api.asOf).toBe(ENTRY_A.time);
    expect(notifyError).not.toHaveBeenCalled();
    await view.unmount();
  });
});
