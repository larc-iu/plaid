import { describe, it, expect, vi } from 'vitest';

// REV-idempotency F6: the import never passed a kept id, so a file imported
// again after its create's answer was lost could make a second document.

const seen = [];
vi.mock('../../domain/umrImport.js', () => ({
  importTarget: () => ({ into: null }),
  importUmrDocument: vi.fn(async (_c, _p, name, _t, _l, options = {}) => {
    seen.push({ name, mint: options.mint });
    if (seen.length === 1) throw Object.assign(new Error('timed out'), { status: 0 });
    return { document: { id: 'd', name }, warnings: [], attached: false };
  }),
}));
vi.mock('../../utils/umrLayerUtils.js', async (orig) => ({
  ...(await orig()),
  getUmrLayerInfo: () => ({ isConfigured: true }),
}));

const { prepareImport } = await import('./prepareUmrImport.js');

describe('importing UMR files', () => {
  it('keeps one id per file across its attempts, and another for another file', async () => {
    const client = {
      projects: { listDocuments: async () => [] },
      withOperation: (_label, fn) => fn(),
    };
    const importFile = await prepareImport({ client, project: {}, projectId: 'p1' });
    const push = () => {};
    await expect(importFile({ text: 'x', index: 0, name: 'a.umr', push })).rejects.toThrow();
    await importFile({ text: 'x', index: 0, name: 'a.umr', push });
    await importFile({ text: 'x', index: 1, name: 'b.umr', push });
    expect(seen[0].mint).toBeTruthy();
    expect(seen[1].mint).toBe(seen[0].mint);
    expect(seen[2].mint).not.toBe(seen[0].mint);
  });
});
