import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// A study reads the audit log and the provenance. Auto-analyze's built-in
// steps used to write under no kind and stamp only a rule's name, so their
// output could not be told from an edit in the log, nor matched to the code
// that wrote it. Each run is now a service run naming the rule
// (`builtin:<name>`), and what it writes names the rule and its version, as a
// bundled service's writes do.

vi.mock('./analysisMemory.js', async (importOriginal) => ({
  ...(await importOriginal()),
  computeAnalysisCopyProposals: () => [{ wordTokenId: 'w-1', analysis: {} }],
}));
vi.mock('./autoLink.js', async (importOriginal) => ({
  ...(await importOriginal()),
  computeAutoLinkProposals: () => [{ tokenId: 'w-1', vocabItemId: 'i-1' }],
  computeMweProposals: () => [{ tokenIds: ['w-1', 'w-2'], vocabItemId: 'i-2' }],
}));

const { runBuiltinAnalysis } = await import('./autoPass.js');

// The hash the stamp promises: of the rule's own file, as git stores it.
const hashOf = (file) =>
  createHash('sha256')
    .update(readFileSync(fileURLToPath(new URL(file, import.meta.url))))
    .digest('hex')
    .slice(0, 8);

const makeDoc = () => {
  const order = [];
  const client = {
    query: vi.fn(async () => ({ results: [] })),
    documents: { get: vi.fn() },
    withOperation: vi.fn(async (_label, fn, tags) => {
      order.push(['operation', tags]);
      return fn();
    }),
  };
  return {
    order,
    id: 'd1',
    projectId: 'p1',
    sentences: [
      {
        tokens: [
          { content: 'aq', annotations: {}, morphemes: [{ annotations: {}, metadata: {} }] },
        ],
      },
    ],
    layerInfo: {
      primaryTokenLayer: { id: 'word-layer', config: {} },
      morphemeTokenLayer: { id: 'morpheme-layer' },
    },
    vocabularies: { v1: { id: 'v1', items: [] } },
    client,
    whenSaved: vi.fn(async () => order.push(['saved'])),
    bulkApplyAnalyses: vi.fn(async () => 1),
    bulkLinkVocab: vi.fn(async () => {
      order.push(['links']);
      return 1;
    }),
    bulkLinkMwes: vi.fn(async () => {
      order.push(['phrases']);
      return 1;
    }),
  };
};

describe('runBuiltinAnalysis in the audit log and the provenance', () => {
  it('copies as a service run naming the rule, stamped with the rule and its version', async () => {
    const doc = makeDoc();
    const res = await runBuiltinAnalysis(doc, { copy: true, link: false });
    expect(res.copied).toBe(1);
    const [, source, opts] = doc.bulkApplyAnalyses.mock.calls[0];
    expect(source).toBe('rule:analysis-precedent');
    expect(opts).toEqual({
      detail: {
        model: 'builtin:analysis-copy',
        version: `0.0.0+${hashOf('./analysisMemory.js')}`,
      },
      kind: 'service-run',
      ref: 'builtin:analysis-copy',
    });
  });

  it('links as one service run naming the rule, opened once the edits before it have landed', async () => {
    const doc = makeDoc();
    const res = await runBuiltinAnalysis(doc, { copy: false, link: true });
    expect(res.linked).toBe(2);
    const run = { kind: 'service-run', ref: 'builtin:precedent' };
    expect(doc.order).toEqual([['saved'], ['operation', run], ['links'], ['phrases']]);
    const detail = { model: 'builtin:precedent', version: `0.0.0+${hashOf('./autoLink.js')}` };
    expect(doc.bulkLinkVocab.mock.calls[0][2]).toEqual({ detail, ...run });
    expect(doc.bulkLinkMwes.mock.calls[0][2]).toEqual({ detail, ...run });
  });
});
