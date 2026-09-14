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
    expect(api.drawerOpen).toBe(true);
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
      selecting = api.selectEntry(ENTRY_A);
    });
    // Clicked: the banner is up before anything has been fetched.
    expect(api.selectedEntry).toBe(ENTRY_A);
    expect(api.isViewingHistorical).toBe(false);

    await view.step(async () => {
      land({ id: 'doc-1' });
      await selecting;
    });
    expect(api.isViewingHistorical).toBe(true);
    await view.unmount();
  });

  it('rolls the selection back when the state never loads', async () => {
    history.fetchHistoricalDocument.mockResolvedValue({ id: 'doc-1' });
    await mount();
    await view.step(() => api.selectEntry(ENTRY_A));
    await settle();
    expect(api.isViewingHistorical).toBe(true);

    history.fetchHistoricalDocument.mockResolvedValue(null);
    await view.step(() => api.selectEntry(ENTRY_B));
    await settle();
    // Back to the entry that is actually on screen, not the one that failed.
    expect(api.selectedEntry).toBe(ENTRY_A);
    await view.unmount();
  });

  // The as-of read is a round trip, and a reader clicking down the list can
  // outrun it. What these two hold is the ORDER of what lands, which the tests
  // above cannot see: each of them asks for one thing at a time, so the screen
  // is right at the end whether or not anything guards the sequence. (The
  // DOCUMENT half of the same race is useDocumentHistory's, and is tested
  // there: this hook's seam hands back one document per call.)
  describe('when a read is overtaken', () => {
    // Two entries clicked in a row, the earlier one slower and FAILING. Its
    // rollback would put back the selection as it was when it started, which
    // is not the one the reader is looking at.
    it('a failed earlier entry does not roll back the later selection', async () => {
      const lands = {};
      history.fetchHistoricalDocument.mockImplementation(
        (time) => new Promise((resolve) => (lands[time] = resolve)),
      );
      await mount();

      let first, second;
      await view.step(() => {
        first = api.selectEntry(ENTRY_A);
      });
      await view.step(() => {
        second = api.selectEntry(ENTRY_B);
      });
      await view.step(async () => {
        lands[ENTRY_B.time]({ id: 'doc-1' });
        await second;
      });
      await view.step(async () => {
        lands[ENTRY_A.time](null);
        await first;
      });
      expect(api.selectedEntry).toBe(ENTRY_B);
      expect(api.isViewingHistorical).toBe(true);
      await view.unmount();
    });

    // And the reader who gives up on a slow entry and closes the drawer stays
    // where they went: a historical view they left must not open behind them.
    it('returning to the current state cancels a read still out', async () => {
      let land;
      history.fetchHistoricalDocument.mockImplementation(
        () => new Promise((resolve) => (land = resolve)),
      );
      await mount();

      let selecting;
      await view.step(() => {
        selecting = api.selectEntry(ENTRY_A);
      });
      await view.step(() => api.selectEntry(null));
      expect(api.selectedEntry).toBe(null);

      await view.step(async () => {
        land({ id: 'doc-1' });
        await selecting;
      });
      expect(api.isViewingHistorical).toBe(false);
      expect(api.selectedEntry).toBe(null);
      await view.unmount();
    });
  });

  it('re-reads the live document on the way back to the current state', async () => {
    history.fetchHistoricalDocument.mockResolvedValue({ id: 'doc-1' });
    await mount();
    await view.step(() => api.selectEntry(ENTRY_A));
    await settle();

    await view.step(() => api.selectEntry(null));
    await settle();
    expect(api.selectedEntry).toBe(null);
    expect(api.isViewingHistorical).toBe(false);
    expect(history.clearHistoricalDocument).toHaveBeenCalled();
    // The as-of GET left the strict-mode version tracker on the old version.
    expect(client.documents.get).toHaveBeenCalledWith('doc-1');
    await view.unmount();
  });

  it('closing the drawer on a historical state returns to the current one', async () => {
    history.fetchHistoricalDocument.mockResolvedValue({ id: 'doc-1' });
    await mount();
    await view.step(() => api.openHistory());
    await view.step(() => api.selectEntry(ENTRY_A));
    await settle();

    await view.step(() => api.closeHistory());
    await settle();
    expect(api.drawerOpen).toBe(false);
    expect(api.selectedEntry).toBe(null);
    expect(api.isViewingHistorical).toBe(false);
    await view.unmount();
  });

  it('a restore leaves the historical view, then reloads the document and the list', async () => {
    history.fetchHistoricalDocument.mockResolvedValue({ id: 'doc-1' });
    await mount();
    await view.step(() => api.selectEntry(ENTRY_A));
    await settle();

    await view.step(() => api.handleRestored());
    await settle();
    expect(api.selectedEntry).toBe(null);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(history.fetchAuditLog).toHaveBeenCalledTimes(1);
    await view.unmount();
  });
});
