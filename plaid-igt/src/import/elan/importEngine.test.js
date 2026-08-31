import { describe, it, expect } from 'vitest';
import {
  deriveSetupData,
  resolveTargets,
  importDocument,
  runElanImport,
  ImportCancelled,
} from './importEngine.js';

const role = (r) => ({ plaid: { role: r } });
const scoped = (name, scope) => ({ id: `sl-${name}`, name, config: { igt: { scope } } });

const PROJECT = {
  id: 'p1',
  textLayers: [
    {
      id: 'tl',
      config: role('baseline'),
      tokenLayers: [
        { id: 'wl', config: role('word'), spanLayers: [scoped('POS', 'Word')] },
        { id: 'sl', config: role('sentence'), spanLayers: [scoped('Translation', 'Sentence')] },
        { id: 'ml', config: role('morpheme'), spanLayers: [scoped('Gloss', 'Morpheme')] },
        { id: 'al', config: role('time-alignment'), spanLayers: [] },
      ],
    },
  ],
};

const BUILD = {
  schema: {
    fields: [
      { name: 'Translation', scope: 'Sentence' },
      { name: 'POS', scope: 'Word' },
      { name: 'Gloss', scope: 'Morpheme' },
    ],
    orthographies: ['IPA'],
    documentMetadata: [{ name: 'Source' }],
  },
  warnings: [],
  documents: [
    {
      id: 'a.eaf',
      name: 'Story',
      metadata: { Source: 'notes' },
      body: 'los perros',
      sentences: [{ begin: 0, end: 10, fields: { Translation: 'the dogs' } }],
      alignments: [{ begin: 0, end: 10, timeBegin: 0.5, timeEnd: 2.25, speaker: 'Ana' }],
      words: [
        { begin: 0, end: 3, sentenceIndex: 0, fields: { POS: 'DET' }, morphemes: [] },
        {
          begin: 4,
          end: 10,
          sentenceIndex: 0,
          fields: { POS: 'NOUN', 'orthog:IPA': 'ˈpe.ros' },
          morphemes: [
            { form: 'perro', morphType: null, fields: { Gloss: 'dog' } },
            { form: 's', morphType: 'enclitic', fields: { Gloss: 'PL' } },
          ],
        },
      ],
      warnings: [],
    },
  ],
};

function stubClient({ documents = [], docMetadata = {} } = {}) {
  const calls = [];
  let seq = 0;
  const next = (prefix) => `${prefix}${++seq}`;
  return {
    calls,
    withOperation: (_name, fn) => fn(),
    projects: {
      get: async () => PROJECT,
      listDocuments: async () => documents,
    },
    documents: {
      create: async (projectId, name, metadata) => {
        calls.push(['documents.create', name, metadata]);
        return { id: 'doc1' };
      },
      get: async (id) => ({ id, metadata: docMetadata[id] ?? {} }),
      delete: async (id) => calls.push(['documents.delete', id]),
      setMetadata: async (id, metadata) => calls.push(['documents.setMetadata', id, metadata]),
    },
    texts: {
      create: async (layerId, docId, body) => {
        calls.push(['texts.create', layerId, body]);
        return { id: 'text1' };
      },
    },
    tokens: {
      bulkCreate: async (specs) => {
        calls.push(['tokens.bulkCreate', specs]);
        return { ids: specs.map(() => next('t')) };
      },
    },
    spans: {
      bulkCreate: async (specs) => {
        calls.push(['spans.bulkCreate', specs]);
        return { ids: specs.map(() => next('s')) };
      },
    },
  };
}

const tokenCalls = (client) =>
  client.calls.filter(([m]) => m === 'tokens.bulkCreate').map(([, specs]) => specs);

describe('deriveSetupData', () => {
  it('turns the build schema into setup-wizard input', () => {
    const setup = deriveSetupData(BUILD, 'My Corpus');
    expect(setup.basicInfo).toEqual({ projectName: 'My Corpus' });
    expect(setup.orthographies.orthographies).toEqual([
      { name: 'Baseline', isBaseline: true },
      { name: 'IPA' },
    ]);
    expect(setup.fields.fields).toEqual([
      { name: 'Translation', scope: 'Sentence', isCustom: true },
      { name: 'POS', scope: 'Word', isCustom: true },
      { name: 'Gloss', scope: 'Morpheme', isCustom: true },
    ]);
    // ELAN carries no lexicon, so no vocabulary is proposed.
    expect(setup.vocabulary.vocabularies).toEqual([]);
    expect(setup.documentMetadata.enabledFields).toEqual([
      { name: 'Source', enabled: true, isCustom: true },
    ]);
  });
});

describe('resolveTargets', () => {
  it('finds every substrate layer including the alignment layer', () => {
    const targets = resolveTargets(PROJECT, BUILD);
    expect(targets).toMatchObject({
      textLayerId: 'tl',
      sentenceLayerId: 'sl',
      wordLayerId: 'wl',
      morphemeLayerId: 'ml',
      alignmentLayerId: 'al',
    });
    expect(targets.spanLayerByScopeName.get('Morpheme:Gloss')).toBe('sl-Gloss');
  });

  it('tolerates a project with no alignment layer', () => {
    const noAlign = {
      ...PROJECT,
      textLayers: [
        {
          ...PROJECT.textLayers[0],
          tokenLayers: PROJECT.textLayers[0].tokenLayers.filter((t) => t.id !== 'al'),
        },
      ],
    };
    expect(resolveTargets(noAlign, BUILD).alignmentLayerId).toBeNull();
  });

  it('refuses when setup did not produce a field the build needs', () => {
    expect(() =>
      resolveTargets(PROJECT, {
        ...BUILD,
        schema: { ...BUILD.schema, fields: [{ name: 'Missing', scope: 'Word' }] },
      }),
    ).toThrow(/Missing/);
  });
});

describe('importDocument', () => {
  it('writes text, sentences, alignment, words and morphemes in order', async () => {
    const client = stubClient();
    const targets = resolveTargets(PROJECT, BUILD);
    await importDocument({ client, projectId: 'p1', targets, doc: BUILD.documents[0] });

    expect(client.calls.map(([m]) => m)).toEqual([
      'documents.create',
      'texts.create',
      'tokens.bulkCreate', // sentences
      'tokens.bulkCreate', // alignment
      'tokens.bulkCreate', // words
      'tokens.bulkCreate', // morphemes
      'spans.bulkCreate',
      'spans.bulkCreate',
      'spans.bulkCreate',
      'documents.setMetadata',
    ]);

    const [sentences, alignment, words, morphemes] = tokenCalls(client);
    expect(sentences).toEqual([{ tokenLayerId: 'sl', text: 'text1', begin: 0, end: 10 }]);
    // Seconds, and the speaker rides along for the timeline UI.
    expect(alignment).toEqual([
      {
        tokenLayerId: 'al',
        text: 'text1',
        begin: 0,
        end: 10,
        metadata: { timeBegin: 0.5, timeEnd: 2.25, speaker: 'Ana' },
      },
    ]);
    // Orthographies ride in token metadata, not in a span layer.
    expect(words.map((w) => w.metadata)).toEqual([{}, { 'orthog:IPA': 'ˈpe.ros' }]);
    // Every word gets at least one morpheme, spanning the whole word.
    expect(morphemes).toEqual([
      {
        tokenLayerId: 'ml',
        text: 'text1',
        begin: 0,
        end: 3,
        precedence: 1,
        metadata: { form: '' },
      },
      {
        tokenLayerId: 'ml',
        text: 'text1',
        begin: 4,
        end: 10,
        precedence: 1,
        metadata: { form: 'perro' },
      },
      {
        tokenLayerId: 'ml',
        text: 'text1',
        begin: 4,
        end: 10,
        precedence: 2,
        metadata: { form: 's', morphType: 'enclitic' },
      },
    ]);
  });

  it('groups spans by layer, since the bulk endpoint requires it', async () => {
    const client = stubClient();
    const targets = resolveTargets(PROJECT, BUILD);
    await importDocument({ client, projectId: 'p1', targets, doc: BUILD.documents[0] });
    const spanCalls = client.calls.filter(([m]) => m === 'spans.bulkCreate').map(([, s]) => s);
    for (const specs of spanCalls) {
      expect(new Set(specs.map((s) => s.spanLayerId)).size).toBe(1);
    }
    const values = spanCalls.flat().map((s) => s.value);
    expect(values.sort()).toEqual(['DET', 'NOUN', 'PL', 'dog', 'the dogs']);
  });

  it('marks the document done LAST, so a crash leaves it redoable', async () => {
    const client = stubClient();
    const targets = resolveTargets(PROJECT, BUILD);
    await importDocument({ client, projectId: 'p1', targets, doc: BUILD.documents[0] });
    const last = client.calls.at(-1);
    expect(last[0]).toBe('documents.setMetadata');
    expect(last[2]).toEqual({ Source: 'notes', elanImported: true });
  });

  it('warns instead of failing when the project has no alignment layer', async () => {
    const client = stubClient();
    const targets = { ...resolveTargets(PROJECT, BUILD), alignmentLayerId: null };
    const warnings = [];
    await importDocument({
      client,
      projectId: 'p1',
      targets,
      doc: BUILD.documents[0],
      warnings,
    });
    expect(warnings[0]).toMatch(/no time-alignment layer/);
    expect(tokenCalls(client)).toHaveLength(3); // sentences, words, morphemes
  });
});

describe('runElanImport', () => {
  it('imports every document and reports the tally', async () => {
    const client = stubClient();
    const result = await runElanImport({ client, projectId: 'p1', build: BUILD });
    expect(result).toMatchObject({ imported: 1, skipped: 0, redone: 0 });
  });

  it('skips a document already marked done and redoes a half-imported one', async () => {
    const done = stubClient({
      documents: [{ id: 'old', name: 'Story' }],
      docMetadata: { old: { elanImported: true } },
    });
    expect(await runElanImport({ client: done, projectId: 'p1', build: BUILD })).toMatchObject({
      imported: 0,
      skipped: 1,
    });
    expect(done.calls.some(([m]) => m === 'documents.create')).toBe(false);

    const partial = stubClient({
      documents: [{ id: 'old', name: 'Story' }],
      docMetadata: { old: {} },
    });
    expect(await runElanImport({ client: partial, projectId: 'p1', build: BUILD })).toMatchObject({
      imported: 1,
      redone: 1,
    });
    expect(partial.calls[0]).toEqual(['documents.delete', 'old']);
  });

  it('stops when asked', async () => {
    const client = stubClient();
    await expect(
      runElanImport({ client, projectId: 'p1', build: BUILD, shouldStop: () => true }),
    ).rejects.toBeInstanceOf(ImportCancelled);
  });
});
