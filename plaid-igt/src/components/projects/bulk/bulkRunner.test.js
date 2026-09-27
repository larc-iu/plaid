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

  // One batch is one transaction holding the server's only write lock, and a
  // batch past MAX_BATCH_OPS is split anyway. A merge larger than one chunk goes
  // document by document, and Apply again sends only the links that did not land.
  it('past one chunk goes by document, and a retry does not link a word twice', async () => {
    const client = makeFakeClient();
    const links = [];
    for (const docId of ['a', 'b'])
      for (let i = 0; i < 300; i++) links.push({ docId, tokens: [`${docId}-${i}`] });
    const create = client.vocabLinks.bulkCreate;
    let refuse = true;
    client.vocabLinks.bulkCreate = async (specs) => {
      if (refuse && specs[0].tokens[0].startsWith('b-')) {
        refuse = false;
        throw Object.assign(new Error('HTTP 500'), { status: 500 });
      }
      return create(specs);
    };
    const run = () =>
      applyMerge(client, { links }, { survivorId: 'k2', loserIds: ['k1'], label: 'Merge' });
    await expect(run()).rejects.toThrow('HTTP 500');
    await run();
    // Every link create that was sent, on the client or in a batch.
    const created = client.calls
      .filter((c) => c.kind === 'vocabLinks.bulkCreate')
      .flatMap((c) => c.args[0].map((spec) => spec.tokens[0]));
    expect(created).toHaveLength(600);
    expect(new Set(created).size).toBe(600);
    expect(client.calls.some((c) => c.kind === 'vocabItems.bulkDelete')).toBe(true);
  });
});

// A text replace names offsets in the text the preview read. Apply again
// after a refusal partway must not respell the documents that already landed.
describe('applyRespell', () => {
  const row = (docId, begin) => ({
    docId,
    textId: `t-${docId}`,
    begin,
    end: begin + 3,
    new: 'kaat',
    morphemes: [],
  });

  it('a retry after a refused document sends only what did not land', async () => {
    const client = makeFakeClient();
    let refuse = true;
    client.batched = async (fn) => {
      const b = client.batch();
      await fn(b);
      if (refuse && client.calls.at(-1).args[0] === 't-b') {
        b.abort();
        throw Object.assign(new Error('HTTP 500'), { status: 500 });
      }
      return b.submit();
    };
    const rows = [row('a', 0), row('b', 4)];
    const opts = { includeMorphemes: true, includeLexicon: false, label: 'Respell' };
    await expect(applyRespell(client, { rows, lexiconRows: [] }, opts)).rejects.toThrow();
    refuse = false;
    const out = await applyRespell(client, { rows, lexiconRows: [] }, opts);
    expect(out.docsChanged).toBe(1);
    const texts = client.calls.filter((c) => c.kind === 'texts.update').map((c) => c.args[0]);
    // a once, then b refused, then b again. Never a second time.
    expect(texts).toEqual(['t-a', 't-b', 't-b']);
  });
});
