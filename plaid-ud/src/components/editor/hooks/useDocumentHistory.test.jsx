import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderComponent } from '@ui/test/renderComponent.jsx';

// The reads themselves are the seam. What is under test is which of them the
// state ends up holding: an as-of read is a round trip, two can be out at once
// (a reader clicking down the entry list), and they can land in either order.
// Only the last one ASKED FOR is about the screen, whichever lands last.
const client = vi.hoisted(() => ({ documents: { get: vi.fn(), audit: vi.fn() } }));
const logout = vi.hoisted(() => vi.fn());

vi.mock('../../../contexts/AuthContext.jsx', () => ({
  useAuth: () => ({ getClient: () => client, logout }),
}));
vi.mock('../../../utils/feedback.jsx', () => ({
  notifyError: vi.fn(),
  humanizeError: (err) => String(err?.message ?? err),
}));

const { useDocumentHistory } = await import('./useDocumentHistory.js');

const A = '2026-09-01T00:00:00Z';
const B = '2026-09-02T00:00:00Z';

let view;
let api;

const Probe = () => {
  api = useDocumentHistory('doc-1');
  return null;
};

// A read per timestamp, each resolved by hand.
const lands = {};
const deferReads = () =>
  client.documents.get.mockImplementation(
    (id, body, time) => new Promise((resolve) => (lands[time] = resolve)),
  );

beforeEach(() => {
  client.documents.get.mockReset();
  client.documents.audit.mockReset();
  logout.mockReset();
  for (const key of Object.keys(lands)) delete lands[key];
});

describe('an as-of read that is overtaken', () => {
  it('does not replace the document the later read put on screen', async () => {
    deferReads();
    view = await renderComponent(<Probe />);

    let first, second;
    await view.step(() => {
      first = api.fetchHistoricalDocument(A);
    });
    await view.step(() => {
      second = api.fetchHistoricalDocument(B);
    });

    await view.step(async () => {
      lands[B]({ id: 'doc-1', at: 'B' });
      await second;
    });
    expect(api.historicalDocument.at).toBe('B');

    // A answers last. The reader is looking at B.
    await view.step(async () => {
      lands[A]({ id: 'doc-1', at: 'A' });
      await first;
    });
    expect(api.historicalDocument.at).toBe('B');
    await view.unmount();
  });

  // The caller still gets what it asked for, and decides for itself what to do
  // with it: the selection half of this race is useHistoryView's guard.
  it('still hands the overtaken read back to its caller', async () => {
    deferReads();
    view = await renderComponent(<Probe />);

    let first, second;
    await view.step(() => {
      first = api.fetchHistoricalDocument(A);
    });
    await view.step(() => {
      second = api.fetchHistoricalDocument(B);
    });
    let got;
    await view.step(async () => {
      lands[B]({ id: 'doc-1', at: 'B' });
      lands[A]({ id: 'doc-1', at: 'A' });
      got = await first;
      await second;
    });
    expect(got.at).toBe('A');
    await view.unmount();
  });

  it('does not land on the live document after a return to the current state', async () => {
    deferReads();
    view = await renderComponent(<Probe />);

    let reading;
    await view.step(() => {
      reading = api.fetchHistoricalDocument(A);
    });
    await view.step(() => api.clearHistoricalDocument());
    expect(api.historicalDocument).toBe(null);

    await view.step(async () => {
      lands[A]({ id: 'doc-1', at: 'A' });
      await reading;
    });
    expect(api.historicalDocument).toBe(null);
    await view.unmount();
  });

  it('holds the document of a read nothing has overtaken', async () => {
    deferReads();
    view = await renderComponent(<Probe />);

    let reading;
    await view.step(() => {
      reading = api.fetchHistoricalDocument(A);
    });
    await view.step(async () => {
      lands[A]({ id: 'doc-1', at: 'A' });
      await reading;
    });
    expect(api.historicalDocument.at).toBe('A');
    await view.unmount();
  });
});
