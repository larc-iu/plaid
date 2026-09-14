import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderComponent } from '@ui/test/renderComponent.jsx';

// The document-history reads are the network, so they are the seam. What is
// under test is the STATE MACHINE around them: an entry is selected the instant
// it is clicked but the historical view only opens once its state has arrived,
// and a fetch that comes back empty must leave the drawer showing whatever was
// on screen before rather than an entry whose state never loaded.
const history = vi.hoisted(() => ({
  auditEntries: [],
  historicalDocument: null,
  loadingAudit: false,
  loadingHistorical: false,
  hasLoadedAudit: false,
  error: '',
  fetchHistoricalDocument: vi.fn(),
  clearHistoricalDocument: vi.fn(),
  fetchAuditLog: vi.fn(),
}));

vi.mock('./useDocumentHistory.js', () => ({ useDocumentHistory: () => history }));

const { useHistoryView } = await import('./useHistoryView.js');

const ENTRY_A = { time: '2026-09-01T00:00:00Z' };
const ENTRY_B = { time: '2026-09-02T00:00:00Z' };

let view;
let api;
let client;
let reload;

const Probe = (props) => {
  api = useHistoryView(props);
  return null;
};

// Let the promises the hook is awaiting run out, inside act.
const settle = () =>
  view.step(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

const mount = async () => {
  view = await renderComponent(
    <Probe documentId="doc-1" getClient={() => client} reload={reload} />,
  );
};

beforeEach(() => {
  history.hasLoadedAudit = false;
  history.fetchHistoricalDocument.mockReset();
  history.clearHistoricalDocument.mockReset();
  history.fetchAuditLog.mockReset();
  // The real one raises the flag itself (useDocumentHistory), and that flag is
  // the whole of the once-only guard below. A bare vi.fn() left the two ends
  // unconnected, so the test had to set the flag by hand and could not have
  // caught the guard being armed by nothing.
  history.fetchAuditLog.mockImplementation(() => {
    history.hasLoadedAudit = true;
  });
  client = { documents: { get: vi.fn(() => Promise.resolve({})) } };
  reload = vi.fn(() => Promise.resolve());
});

describe('the history view', () => {
  it('reads the entry list the first time the drawer opens, and not again', async () => {
    await mount();
    await view.step(() => api.openHistory());
    expect(api.isHistoryDrawerOpen).toBe(true);
    expect(history.fetchAuditLog).toHaveBeenCalledTimes(1);

    await view.step(() => api.closeHistory());
    await view.step(() => api.openHistory());
    expect(history.fetchAuditLog).toHaveBeenCalledTimes(1);
    await view.unmount();
  });

  it('selects the entry at once and opens the historical view only once its state lands', async () => {
    let land;
    history.fetchHistoricalDocument.mockImplementation(
      () => new Promise((resolve) => (land = resolve)),
    );
    await mount();
    // Deliberately not awaited here: the point is what the screen says while
    // the as-of read is still in flight.
    let selecting;
    await view.step(() => {
      selecting = api.selectHistoryEntry(ENTRY_A);
    });
    // Clicked: the banner is up before anything has been fetched.
    expect(api.selectedHistoryEntry).toBe(ENTRY_A);
    expect(api.viewingHistoricalState).toBe(false);

    await view.step(async () => {
      land({ id: 'doc-1' });
      await selecting;
    });
    expect(api.viewingHistoricalState).toBe(true);
    await view.unmount();
  });

  it('rolls the selection back when the state never loads', async () => {
    history.fetchHistoricalDocument.mockResolvedValue({ id: 'doc-1' });
    await mount();
    await view.step(() => api.selectHistoryEntry(ENTRY_A));
    await settle();
    expect(api.viewingHistoricalState).toBe(true);

    history.fetchHistoricalDocument.mockResolvedValue(null);
    await view.step(() => api.selectHistoryEntry(ENTRY_B));
    await settle();
    // Back to the entry that is actually on screen, not the one that failed.
    expect(api.selectedHistoryEntry).toBe(ENTRY_A);
    await view.unmount();
  });

  it('re-reads the live document on the way back to the current state', async () => {
    history.fetchHistoricalDocument.mockResolvedValue({ id: 'doc-1' });
    await mount();
    await view.step(() => api.selectHistoryEntry(ENTRY_A));
    await settle();

    await view.step(() => api.selectHistoryEntry(null));
    await settle();
    expect(api.selectedHistoryEntry).toBe(null);
    expect(api.viewingHistoricalState).toBe(false);
    expect(history.clearHistoricalDocument).toHaveBeenCalled();
    // The as-of GET left the strict-mode version tracker on the old version.
    expect(client.documents.get).toHaveBeenCalledWith('doc-1');
    await view.unmount();
  });

  it('closing the drawer on a historical state returns to the current one', async () => {
    history.fetchHistoricalDocument.mockResolvedValue({ id: 'doc-1' });
    await mount();
    await view.step(() => api.openHistory());
    await view.step(() => api.selectHistoryEntry(ENTRY_A));
    await settle();

    await view.step(() => api.closeHistory());
    await settle();
    expect(api.isHistoryDrawerOpen).toBe(false);
    expect(api.selectedHistoryEntry).toBe(null);
    expect(api.viewingHistoricalState).toBe(false);
    await view.unmount();
  });

  it('a restore leaves the historical view, then reloads the document and the list', async () => {
    history.fetchHistoricalDocument.mockResolvedValue({ id: 'doc-1' });
    await mount();
    await view.step(() => api.selectHistoryEntry(ENTRY_A));
    await settle();

    await view.step(() => api.handleRestored());
    await settle();
    expect(api.selectedHistoryEntry).toBe(null);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(history.fetchAuditLog).toHaveBeenCalledTimes(1);
    await view.unmount();
  });
});
