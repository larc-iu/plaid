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
