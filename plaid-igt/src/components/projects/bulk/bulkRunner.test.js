import { describe, it, expect, vi } from 'vitest';
import { applyField, applyMerge, applyReanalyze, applyRespell } from './bulkRunner.js';
import { openPrecedent } from '@/domain/precedentCache.js';
import { makeFakeClient } from '@/domain/test-helpers.js';

// A Bulk Edit writes to documents other than any one open, so a project
// precedent read taken before it (precedentCache.js) holds rows it changed.
// Every apply drops those reads, so the next document opened reads again.

const layerInfo = {
  primaryTokenLayer: { id: 'wordL' },
  morphemeTokenLayer: null,
  spanLayers: { word: [{ id: 'glossL', name: 'Gloss' }], morpheme: [], sentence: [] },
};

let logins = 0;
function precedentClient() {
  return {
    baseUrl: 'http://core',
    token: `bulk-${++logins}`,
    projects: { listDocuments: async () => [{ id: 'a', version: 1 }] },
    query: vi.fn(async () => ({ results: [] })),
    withOperation: async (_label, fn) => fn(),
    batched: async (fn) =>
      fn({
        texts: { update: () => {} },
        tokens: { bulkUpdate: () => {} },
        vocabItems: { bulkUpdate: () => {}, bulkDelete: () => {} },
        vocabLinks: { bulkCreate: () => {} },
      }),
    spans: { bulkUpdate: async () => ({}) },
    tokens: { bulkUpdate: async () => ({}) },
    vocabItems: { bulkUpdate: async () => ({}), bulkDelete: async () => ({}) },
    vocabLinks: { bulkCreate: async () => ({}) },
  };
}

const docOf = (client) => ({
  id: 'a',
  raw: { id: 'a', version: 1 },
  projectId: 'p1',
  client,
  layerInfo,
  vocabularies: {},
  dataVersion: 0,
  sentences: [],
});

const projectReads = (client) => client.query.mock.calls.filter(([q]) => !q.where[0][2].doc).length;

const applies = {
  respell: (client) =>
    applyRespell(
      client,
      { rows: [{ docId: 'a', textId: 't', morphemes: [] }], lexiconRows: [] },
      { label: 'Respell' },
    ),
  field: (client) =>
    applyField(client, { rows: [{ kind: 'span', id: 's', new: 'x' }] }, { label: 'Replace' }),
  reanalyze: (client) =>
    applyReanalyze(
      client,
      { rows: [{ docId: 'a', id: 'w' }], docs: [{ id: 'a', bulkReplaceAnalyses: async () => 1 }] },
      { analysis: {}, label: 'Re-analyze' },
    ),
  merge: (client) =>
    applyMerge(
      client,
      { links: [{ docId: 'a', tokens: ['w'] }] },
      { survivorId: 'k2', loserIds: ['k1'], label: 'Merge' },
    ),
};

describe('Bulk Edit and the project precedent read', () => {
  for (const [name, apply] of Object.entries(applies)) {
    it(`${name} drops the read, so the next document reads the project again`, async () => {
      const client = precedentClient();
      await openPrecedent(docOf(client));
      expect(projectReads(client)).toBe(1);
      await apply(client);
      await openPrecedent(docOf(client));
      expect(projectReads(client)).toBe(2);
    });
  }
});

// A merge is link creates, reference updates and the losers' delete. Sent as
// separate requests, a refused delete left each word linked to both entries,
// and a retry of the plan still on screen linked it to the survivor twice.
describe('applyMerge', () => {
  it('sends every write of the merge as one batch', async () => {
    const client = makeFakeClient();
    await applyMerge(
      client,
      {
        links: [
          { docId: 'a', tokens: ['w1'] },
          { docId: 'b', tokens: ['w2'], metadata: { note: 'x' } },
        ],
        refUpdates: [{ id: 'k3', metadata: [{ op: 'set', path: ['parent'], value: 'k2' }] }],
      },
      { survivorId: 'k2', loserIds: ['k1'], label: 'Merge' },
    );
    const kinds = client.calls.map((c) => c.kind).filter((k) => k !== 'beginOperation');
    expect(kinds).toEqual([
      'vocabLinks.bulkCreate',
      'vocabLinks.bulkCreate',
      'vocabItems.bulkUpdate',
      'vocabItems.bulkDelete',
      'batch.submit',
    ]);
    expect(client.calls[1].args[0]).toEqual([{ vocabItem: 'k2', tokens: ['w1'] }]);
  });
});
