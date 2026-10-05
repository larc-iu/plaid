import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderComponent } from '../test/renderComponent.jsx';
import { OPS_SHOWN, useDocumentHistory } from './useDocumentHistory.js';

// The log as the rail reads it: pages of entries. `audit` answers with the
// entries, so a test counts reads and stages answers on it.
const pagesOf = (audit) => ({
  auditPage: (...args) => audit(...args).then((entries) => ({ entries, nextCursor: null })),
});

// The entry list, and what the rail says when it cannot be read.
//
// The drawer renders `error` verbatim, so whatever is put there is on screen as
// written. A raw client message is "HTTP 403 ... at http://host/api/v1/
// documents/<uuid>/audit", which tells a linguist nothing and shows them the
// inside of the app. And an expired token is a fact about the session, not
// about the history, so it belongs to the screen rather than to the rail.

const ENTRIES = [{ id: 'a', time: '2026-09-01T00:00:00Z' }];

let audit;
let client;
let onExpired;

// The probe hands what it knows out on a stable object, since a test cannot
// read a hook's return off the DOM.
const hook = {};
const api = () => hook.api;

const Probe = () => {
  hook.api = useDocumentHistory({ documentId: 'doc-1', client, onExpired });
  return null;
};

const mount = () => renderComponent(<Probe />);

const failing = (message, status) =>
  vi.fn(() => {
    const err = new Error(message);
    if (status) err.status = status;
    return Promise.reject(err);
  });

beforeEach(() => {
  audit = vi.fn(() => Promise.resolve(ENTRIES));
  client = { documents: pagesOf(audit) };
  onExpired = vi.fn();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('the history entry list', () => {
  it('reads the entries and clears any earlier error', async () => {
    const view = await mount();
    await view.step(() => api().fetchAuditLog());
    expect(api().auditEntries).toEqual(ENTRIES);
    expect(api().hasLoadedAudit).toBe(true);
    expect(api().error).toBe('');
    expect(api().loadingAudit).toBe(false);
    await view.unmount();
  });

  it('says what went wrong in the reader’s words, not the request’s', async () => {
    audit = failing('HTTP 403 Forbidden at http://localhost:8085/api/v1/documents/x/audit');
    client = { documents: pagesOf(audit) };
    const view = await mount();
    await view.step(() => api().fetchAuditLog());
    expect(api().error).toBe("You don't have permission to do that.");
    expect(api().loadingAudit).toBe(false);
    await view.unmount();
  });

  it('keeps a message with nothing to classify, minus the request', async () => {
    audit = failing('HTTP 400 the as-of time is in the future at http://localhost:8085/api/v1/x');
    client = { documents: pagesOf(audit) };
    const view = await mount();
    await view.step(() => api().fetchAuditLog());
    expect(api().error).toBe('the as-of time is in the future');
    await view.unmount();
  });

  it('hands an expired session to the screen instead of the rail', async () => {
    audit = failing('Not authenticated');
    client = { documents: pagesOf(audit) };
    const view = await mount();
    await view.step(() => api().fetchAuditLog());
    expect(onExpired).toHaveBeenCalledTimes(1);
    // Nothing in the rail: the screen is about to be replaced by the login.
    expect(api().error).toBe('');
    expect(api().loadingAudit).toBe(false);
    await view.unmount();
  });

  it('answers a 401 the same way, however the client said it', async () => {
    audit = failing('HTTP 401 Unauthorized at http://localhost:8085/api/v1/x', 401);
    client = { documents: pagesOf(audit) };
    const view = await mount();
    await view.step(() => api().fetchAuditLog());
    expect(onExpired).toHaveBeenCalledTimes(1);
    expect(api().error).toBe('');
    await view.unmount();
  });

  it('reads nothing without a document or a client', async () => {
    client = null;
    const view = await mount();
    await view.step(() => api().fetchAuditLog());
    expect(api().hasLoadedAudit).toBe(false);
    await view.unmount();
  });
});

// One run of a machine service can be a single entry of tens of thousands of
// writes. The rail reads each entry cut to its oldest actions, and reads the
// rest of one only when asked.
describe('long entries', () => {
  const op = (n) => ({ id: `op${n}`, time: `2026-09-01T00:00:${String(n).padStart(2, '0')}Z` });
  const range = (from, to) => Array.from({ length: to - from }, (_, i) => op(from + i));

  it('reads every page, each entry cut to its oldest actions', async () => {
    const auditPage = vi
      .fn()
      .mockResolvedValueOnce({ entries: [{ id: 'a' }], nextCursor: 'c1' })
      .mockResolvedValueOnce({ entries: [{ id: 'b' }], nextCursor: null });
    client = { documents: { auditPage } };
    const view = await mount();
    await view.step(() => api().fetchAuditLog());
    expect(api().auditEntries.map((e) => e.id)).toEqual(['a', 'b']);
    expect(auditPage.mock.calls).toEqual([
      ['doc-1', { limit: 1000, opsLimit: OPS_SHOWN, cursor: undefined }],
      ['doc-1', { limit: 1000, opsLimit: OPS_SHOWN, cursor: 'c1' }],
    ]);
    await view.unmount();
  });

  it('reads the next actions of an entry from its last one held', async () => {
    const cut = { id: 'g', opCount: 5, ops: range(0, 2) };
    const auditPage = vi
      .fn()
      .mockResolvedValueOnce({ entries: [cut], nextCursor: null })
      .mockResolvedValueOnce({ entries: [{ ...cut, ops: range(1, 4) }], nextCursor: null })
      .mockResolvedValueOnce({ entries: [cut], nextCursor: null });
    client = { documents: { auditPage } };
    const view = await mount();
    await view.step(() => api().fetchAuditLog());
    await view.step(() => api().loadMoreOps('g'));
    expect(auditPage.mock.calls[1]).toEqual([
      'doc-1',
      { entryId: 'g', startTime: op(1).time, opsLimit: OPS_SHOWN + 1 },
    ]);
    expect(api().auditEntries[0].ops).toEqual(range(0, 4));
    expect(api().loadingMore).toBe(null);
    // A re-read after an edit keeps what was loaded.
    await view.step(() => api().fetchAuditLog());
    expect(api().auditEntries[0].ops).toEqual(range(0, 4));
    await view.unmount();
  });
});
