import { describe, it, expect, vi } from 'vitest';

// H12-IO-4: a .umr file whose name is decomposed (as macOS writes `é`) did
// not attach to the document of that name, which the server stores composed,
// and made a second document beside it.

const imported = [];
vi.mock('../../domain/umrImport.js', () => ({
  importTarget: (doc) => ({ into: doc }),
  importUmrDocument: vi.fn(async (_c, _p, name, _t, _l, options = {}) => {
    imported.push({ name, into: options.into?.id ?? null });
    return { document: { id: options.into?.id ?? 'new' }, warnings: [], attached: !!options.into };
  }),
}));
vi.mock('../../utils/umrLayerUtils.js', async (orig) => ({
  ...(await orig()),
  getUmrLayerInfo: () => ({ isConfigured: true }),
}));

const { prepareImport } = await import('./prepareUmrImport.js');

const client = {
  projects: { listDocuments: async () => [{ id: 'igt-doc', name: 'Navaj\u00e9' }] },
  documents: { get: async (id) => ({ id }) },
  withOperation: (_label, fn) => fn(),
};

describe('a UMR file named in the other Unicode spelling', () => {
  it('attaches to the document of that name', async () => {
    const importFile = await prepareImport({ client, project: {}, projectId: 'p1' });
    const name = 'Navaje\u0301';
    const file = { name: `${name}.umr`, size: 10, lastModified: 1 };
    await importFile({ file, text: 'x', index: 0, name, push: () => {} });
    expect(imported).toEqual([{ name, into: 'igt-doc' }]);
  });
});
