import { describe, it, expect, vi } from 'vitest';

// H2-IGT-ANALYZE-3: each committed cell froze a 43k-token document for about
// a second, most of it a diff of the whole document before and after the edit
// (`footprintOf`, `pendingIdsOf`) that only a refused edit needs.

const spies = vi.hoisted(() => ({ footprintOf: null, pendingIdsOf: null }));
vi.mock('./rebase.js', async (importOriginal) => {
  const real = await importOriginal();
  spies.footprintOf = vi.fn(real.footprintOf);
  spies.pendingIdsOf = vi.fn(real.pendingIdsOf);
  return { ...real, footprintOf: spies.footprintOf, pendingIdsOf: spies.pendingIdsOf };
});

const { DocumentModel } = await import('./DocumentModel.js');
const { newId } = await import('./pendingIds.js');

const client = () => ({
  withOperation: async (_label, fn, opts) => {
    client.minted = opts?.minted;
    return fn();
  },
});

describe('a send that lands', () => {
  it('names the rows it makes without diffing the whole document', async () => {
    const c = client();
    const doc = new DocumentModel({ raw: { id: 'd1', rows: [] }, client: c, user: { id: 'u' } });
    doc._canWrite = () => true;
    const id = newId();
    doc._applyRawPatch((raw) => {
      raw.rows.push({ id, value: 'x' });
    });
    const sent = await doc._queueWrite('Failed to add a row', async () => {});
    expect(sent).not.toBe(false);
    expect([...client.minted]).toEqual([id]);
    expect(spies.footprintOf).not.toHaveBeenCalled();
    expect(spies.pendingIdsOf).not.toHaveBeenCalled();
    expect(doc.raw.rows).toEqual([{ id, value: 'x' }]);
  });
});

// REV-FX-UI F1: one refused create left the whole diff on every later send.
describe('a send after a refused create', () => {
  it('diffs the document only when the edit names the refused row', async () => {
    const c = client();
    const doc = new DocumentModel({ raw: { id: 'd1', rows: [] }, client: c, user: { id: 'u' } });
    doc._canWrite = () => true;
    doc.onError = () => {};
    doc._fetch = async () => ({ id: 'd1', rows: [] });
    const refused = newId();
    doc._applyRawPatch((raw) => {
      raw.rows.push({ id: refused, value: 'x' });
    });
    await doc._queueWrite('Failed to add a row', async () => {
      throw Object.assign(new Error('HTTP 422'), {
        status: 422,
        responseData: { violations: [{}] },
      });
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(doc._refusedIds.has(refused)).toBe(true);
    spies.footprintOf.mockClear();
    spies.pendingIdsOf.mockClear();
    const id = newId();
    doc._applyRawPatch((raw) => {
      raw.rows = raw.rows.filter((r) => r.id !== refused);
      raw.rows.push({ id, value: 'y' });
    });
    await doc._queueWrite('Failed to add a row', async () => {});
    expect(spies.footprintOf).not.toHaveBeenCalled();
    expect(spies.pendingIdsOf).not.toHaveBeenCalled();
  });
});

// REV-FX-UI F2: the copy kept a metadata key named `__proto__` as the copy's
// prototype instead of a key.
describe('the copy a patch is made on', () => {
  it('keeps a key named __proto__ as a key', () => {
    const raw = JSON.parse('{"id":"d1","rows":[],"metadata":{"__proto__":{"x":1},"note":"n"}}');
    const doc = new DocumentModel({ raw, user: { id: 'u' } });
    doc._applyRawPatch((next) => {
      next.metadata.note = 'm';
    });
    expect(Object.keys(doc.raw.metadata)).toEqual(['__proto__', 'note']);
    expect(JSON.stringify(doc.raw.metadata)).toBe('{"__proto__":{"x":1},"note":"m"}');
  });
});
