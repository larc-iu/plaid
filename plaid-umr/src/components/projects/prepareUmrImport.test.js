import { describe, it, expect, vi } from 'vitest';

// REV-idempotency F6, REV2 G4: an import made again after a create whose
// answer was lost made a second document, since the kept id lived inside one
// import. The page makes a new import (prepareImport) each time, so the id is
// kept for the file while the page is open, and dropped once it is imported.

const seen = [];
let fail = 0;
vi.mock('../../domain/umrImport.js', () => ({
  importTarget: () => ({ into: null }),
  importUmrDocument: vi.fn(async (_c, _p, name, _t, _l, options = {}) => {
    seen.push({ name, mint: options.mint });
    if (fail > 0) {
      fail -= 1;
      throw Object.assign(new Error('timed out'), { status: 0 });
    }
    return { document: { id: 'd', name }, warnings: [], attached: false };
  }),
}));
vi.mock('../../utils/umrLayerUtils.js', async (orig) => ({
  ...(await orig()),
  getUmrLayerInfo: () => ({ isConfigured: true }),
}));

const { prepareImport } = await import('./prepareUmrImport.js');

const client = {
  projects: { listDocuments: async () => [] },
  withOperation: (_label, fn) => fn(),
};
const file = { name: 'a.umr', size: 10, lastModified: 1 };
const importOnce = async (f = file) => {
  const importFile = await prepareImport({ client, project: {}, projectId: 'p1' });
  return importFile({ file: f, text: 'x', index: 0, name: 'a', push: () => {} });
};

describe('importing a UMR file again', () => {
  it('after a lost create names the same id, and after a success a new one', async () => {
    fail = 1;
    await expect(importOnce()).rejects.toThrow();
    await importOnce();
    await importOnce();
    await importOnce({ ...file, lastModified: 2 });
    expect(seen[0].mint).toBeTruthy();
    expect(seen[1].mint).toBe(seen[0].mint);
    expect(seen[2].mint).not.toBe(seen[1].mint);
    expect(seen[3].mint).not.toBe(seen[2].mint);
  });
});
