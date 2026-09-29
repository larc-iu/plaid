import { describe, it, expect, vi } from 'vitest';
import {
  applyField,
  applyMerge,
  applyReanalyze,
  applyRespell,
  planField,
  planMerge,
  planReanalyze,
  planRespell,
} from './bulkRunner.js';
import { buildReplacer } from './bulkPlan.js';
import { openPrecedent } from '@/domain/precedentCache.js';
import { buildRawDoc, makeFakeClient } from '@/domain/test-helpers.js';
import { getIgtLayerInfo } from '@/domain/layerInfo.js';

// A Bulk Edit writes to documents other than any one open, so a project
// precedent read taken before it (precedentCache.js) holds rows it changed.
// Every apply drops those reads, so the next document opened reads again.

const layerInfo = {
  primaryTokenLayer: { id: 'wordL' },
  morphemeTokenLayer: null,
  spanLayers: { word: [{ id: 'glossL', name: 'Gloss' }], morpheme: [], sentence: [] },
};

// The client's strict mode, as the real one keeps it: the document every write
// is stamped for, and the versions it knows.
const strictMode = () => ({
  documentVersions: {},
  strictModeDocumentId: null,
  enterStrictMode(docId) {
    this.strictModeDocumentId = docId;
  },
  exitStrictMode() {
    this.strictModeDocumentId = null;
  },
});

let logins = 0;
function precedentClient() {
  return {
    ...strictMode(),
    baseUrl: 'http://core',
    token: `bulk-${++logins}`,
    projects: { listDocuments: async () => [{ id: 'a', version: 1 }] },
    documents: { get: async (id) => ({ id, version: 1 }) },
    vocabLayers: { get: async (id) => ({ id, items: [] }) },
    query: vi.fn(async () => ({ results: [] })),
    withOperation: async (_label, fn) => fn(),
    batched: async (fn) => {
      await fn({
        texts: { update: () => {} },
        spans: { bulkUpdate: () => {} },
        tokens: { bulkUpdate: () => {} },
        vocabItems: { bulkUpdate: () => {}, merge: () => {} },
      });
      return [];
    },
    spans: { bulkUpdate: async () => ({}) },
    tokens: { bulkUpdate: async () => ({}) },
    vocabItems: { bulkUpdate: async () => ({}) },
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
      { rows: [{ docId: 'a', textId: 't', morphemes: [] }], lexiconRows: [], versions: { a: 1 } },
      { label: 'Respell' },
    ),
  field: (client) =>
    applyField(
      client,
      { rows: [{ kind: 'span', id: 's', docId: 'a', new: 'x' }], versions: { a: 1 } },
      { label: 'Replace' },
    ),
  reanalyze: (client) =>
    applyReanalyze(
      client,
      {
        rows: [{ docId: 'a', id: 'w' }],
        docs: [{ id: 'a', raw: { version: 1 }, bulkReplaceAnalyses: async () => 1 }],
      },
      { analysis: {}, label: 'Re-analyze' },
    ),
  merge: (client) => applyMerge(client, {}, { survivorId: 'k2', loserIds: ['k1'], label: 'Merge' }),
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

// The audit log is a study's record: every apply is one operation of kind
// bulk-edit, whose ref names which of the four changes it was.
describe('Bulk Edit in the audit log', () => {
  const actions = { respell: 'respell', field: 'replace', reanalyze: 'reanalyze', merge: 'merge' };
  for (const [name, apply] of Object.entries(applies)) {
    it(`${name} is one bulk-edit operation`, async () => {
      const client = precedentClient();
      const opts = [];
      client.withOperation = async (_label, fn, o) => {
        opts.push(o);
        return fn();
      };
      await apply(client);
      expect(opts).toEqual([{ kind: 'bulk-edit', ref: `action:${actions[name]}` }]);
    });
  }
});

// A merge is the reference updates and the core's merge, in one batch. The
// core moves every link the losers have when it runs, so a link made after
// the preview follows too (it was deleted with the loser when the links were
// harvested at Preview and re-made one by one).
describe('applyMerge', () => {
  const mergeClient = (answer) => {
    const queued = [];
    return {
      queued,
      withOperation: async (_label, fn) => fn(),
      batched: async (fn) => {
        const op =
          (kind) =>
          (...args) =>
            queued.push([kind, ...args]);
        await fn({
          vocabItems: {
            bulkUpdate: op('vocabItems.bulkUpdate'),
            merge: op('vocabItems.merge'),
            bulkDelete: op('vocabItems.bulkDelete'),
          },
          vocabLinks: { bulkCreate: op('vocabLinks.bulkCreate') },
        });
        return queued.map(([kind]) => ({
          status: 200,
          body: kind === 'vocabItems.merge' ? answer : {},
        }));
      },
    };
  };

  it('sends the reference updates and the merge as one batch, and reports what the core did', async () => {
    const client = mergeClient({ moved: 3, duplicates: 1, removed: ['k1'] });
    const refUpdates = [{ id: 'k3', metadata: [{ op: 'set', path: ['parent'], value: 'k2' }] }];
    const out = await applyMerge(
      client,
      { refUpdates },
      { survivorId: 'k2', loserIds: ['k1'], label: 'Merge' },
    );
    expect(client.queued).toEqual([
      ['vocabItems.bulkUpdate', refUpdates],
      ['vocabItems.merge', 'k2', ['k1']],
    ]);
    expect(out).toEqual({
      linksMoved: 3,
      duplicatesRemoved: 1,
      entriesRemoved: 1,
      entriesRepointed: 1,
    });
  });

  it('makes no link of its own and deletes nothing itself', async () => {
    const client = mergeClient({ moved: 0, duplicates: 0, removed: [] });
    await applyMerge(client, {}, { survivorId: 'k2', loserIds: ['k1', 'k4'], label: 'Merge' });
    expect(client.queued).toEqual([['vocabItems.merge', 'k2', ['k1', 'k4']]]);
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

  const versions = { a: 1, b: 1 };

  it('a retry after a refused document sends only what did not land', async () => {
    const client = Object.assign(makeFakeClient(), strictMode());
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
    await expect(applyRespell(client, { rows, lexiconRows: [], versions }, opts)).rejects.toThrow();
    refuse = false;
    const out = await applyRespell(client, { rows, lexiconRows: [], versions }, opts);
    expect(out.docsChanged).toBe(1);
    const texts = client.calls.filter((c) => c.kind === 'texts.update').map((c) => c.args[0]);
    // a once, then b refused, then b again. Never a second time.
    expect(texts).toEqual(['t-a', 't-b', 't-b']);
  });

  it('never renames an entry of a vocabulary the person does not maintain', async () => {
    const client = makeFakeClient();
    client.vocabLayers.get = async (id) => ({
      id,
      items: [
        { id: 'i1', form: 'kat' },
        { id: 'i2', form: 'kit' },
      ],
    });
    const lexiconRows = [
      { id: 'i1', kind: 'lexicon', vocabId: 'v1', old: 'kat', new: 'cat' },
      { id: 'i2', kind: 'lexicon', vocabId: 'v1', old: 'kit', new: 'cit', locked: true },
    ];
    const out = await applyRespell(
      client,
      { rows: [], lexiconRows },
      { includeLexicon: true, label: 'Respell' },
    );
    expect(out.entriesChanged).toBe(1);
    const sent = client.calls
      .filter((c) => c.kind === 'vocabItems.bulkUpdate')
      .flatMap((c) => c.args[0].map((u) => u.id));
    expect(sent).toEqual(['i1']);
  });
});

// A preview reads every document a change touches. Each read names only the
// layers the preview looks at, and the entry lists are shared by the run.
describe('the previews read what they need', () => {
  const project = () => {
    const p = buildRawDoc();
    p.id = 'p1';
    p.vocabs = [{ id: 'v1' }];
    // Another app's token layer, whose links a merge must still see.
    p.textLayers[0].tokenLayers.push({ id: 'udL', config: {}, spanLayers: [] });
    return p;
  };
  const readClient = () => {
    const reads = [];
    return {
      reads,
      query: async () => ({
        results: [
          ['d1', 2],
          ['d2', 1],
        ],
      }),
      documents: {
        get: async (id, full, asOf, layers) => {
          reads.push({ id, layers: layers ? [...layers].sort() : null });
          return { ...buildRawDoc({ body: 'ka ta' }), id };
        },
      },
      vocabLayers: {
        get: async () => ({ id: 'v1', name: 'Lexicon', items: [{ id: 'k1', form: 'ka' }] }),
      },
    };
  };
  const substrate = ['alignL', 'morphL', 'sentL', 'tl-1', 'wordL'];
  const replace = buildReplacer('ka', 'exact', 'kaa');

  it('a respell reads the text, the words and the morphemes', async () => {
    const client = readClient();
    const p = project();
    const { docs } = await planRespell(client, p, getIgtLayerInfo(p), {
      find: 'ka',
      matchType: 'exact',
      apply: replace.apply,
    });
    expect(docs.map((d) => d.id)).toEqual(['d1', 'd2']);
    expect(client.reads.map((r) => r.layers)).toEqual([substrate, substrate]);
  });

  it('a field replace reads its one field too', async () => {
    const client = readClient();
    const target = { kind: 'span', layerId: 'msl-0', scope: 'morpheme', field: 'Gloss' };
    await planField(client, project(), target, {
      find: 'x',
      matchType: 'exact',
      apply: replace.apply,
    });
    expect(client.reads[0].layers).toEqual([...substrate, 'msl-0'].sort());
    const forms = readClient();
    await planField(
      forms,
      project(),
      { kind: 'morpheme', layerId: 'morphL' },
      {
        find: 'x',
        matchType: 'exact',
        apply: replace.apply,
      },
    );
    expect(forms.reads[0].layers).toEqual(substrate);
  });

  it('a merge counts the linked words and reads no document', async () => {
    const client = readClient();
    expect(await planMerge(client, 'v1', ['k1', 'k2'])).toEqual({ tokens: 6, docs: 2 });
    expect(client.reads).toEqual([]);
  });

  it('a re-analyze reads every field, over one shared entry list', async () => {
    const client = readClient();
    const p = project();
    const { docs } = await planReanalyze(client, p, getIgtLayerInfo(p), 'ka');
    expect(client.reads[0].layers).toEqual([...substrate, 'msl-0', 'ssl-0', 'wsl-0'].sort());
    const [a, b] = docs.map((d) => d.vocabularies.v1.items);
    expect(a).toBe(b);
    expect(Object.isFrozen(a)).toBe(true);
  });
});
