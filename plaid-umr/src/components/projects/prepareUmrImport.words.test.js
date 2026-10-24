import { describe, it, expect, vi } from 'vitest';

// A file whose words differ from the document of the same name is imported as
// a document of its own. What says so is the error's class, WordsDiffer, never
// its wording, which the copy rules may change (R2-IO-8).

const calls = [];
let refusal = null;
vi.mock('../../domain/umrImport.js', () => {
  class WordsDiffer extends Error {}
  return {
    WordsDiffer,
    importTarget: () => ({ into: { id: 'd0' } }),
    importUmrDocument: vi.fn(async (_c, _p, name, _t, _l, options = {}) => {
      calls.push({ into: options.into ?? null });
      if (options.into && refusal) throw refusal(WordsDiffer);
      return { document: { id: 'd1', name }, warnings: [], attached: !!options.into };
    }),
  };
});
vi.mock('../../utils/umrLayerUtils.js', async (orig) => ({
  ...(await orig()),
  getUmrLayerInfo: () => ({ isConfigured: true }),
}));

const { prepareImport } = await import('./prepareUmrImport.js');

const client = {
  projects: { listDocuments: async () => [{ id: 'd0', name: 'a' }] },
  documents: { get: async (id) => ({ id }) },
  withOperation: (_label, fn) => fn(),
};
const importOnce = async () => {
  const rows = [];
  const importFile = await prepareImport({ client, project: {}, projectId: 'p1' });
  await importFile({
    file: { name: 'a.umr', size: 10, lastModified: 1 },
    text: 'x',
    index: 0,
    name: 'a',
    push: (row) => rows.push(row),
  });
  return rows;
};

describe('a UMR file whose words differ from the document', () => {
  it('is imported as a new document when the refusal is a WordsDiffer, whatever it says', async () => {
    calls.length = 0;
    refusal = (WordsDiffer) => new WordsDiffer('Satz 1 weicht ab.');
    const rows = await importOnce();
    expect(calls).toEqual([{ into: { id: 'd0' } }, { into: null }]);
    expect(rows[0].status).toBe('imported');
    expect(rows[0].warnings[0]).toBe('Imported as a new document: Satz 1 weicht ab.');
  });

  it('is refused when another error says "differs"', async () => {
    calls.length = 0;
    refusal = () => new Error('The file differs from what the server holds.');
    await expect(importOnce()).rejects.toThrow('differs');
    expect(calls).toHaveLength(1);
  });
});
