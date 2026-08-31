import { describe, it, expect } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { readCldfDataset } from './readDataset.js';
import { buildCldfDocuments } from './buildDocuments.js';
import { deriveSetupData, resolveTargets, runCldfImport } from './importEngine.js';
import { documentFraction } from '../progress.js';
import { buildCldfDataset } from '../../export/cldf.js';
import { makeFixtureDoc } from '../../export/testFixtures.js';

// A build produced by exporting the shared fixture and reading it back, so the
// engine is exercised against the same data the exporter really writes.
function fixtureBuild() {
  const { files } = buildCldfDataset({
    project: { name: 'Fieldwork' },
    languages: {
      object: { name: 'Spanish', glottocode: 'stan1288', iso639P3: 'spa' },
      meta: { name: 'English', iso639P3: 'eng' },
    },
    documents: [{ igtDoc: makeFixtureDoc() }],
    vocabularies: [
      {
        id: 'v1',
        name: 'Lexicon',
        config: { igt: { fields: { gloss: {}, pos: {} } } },
        items: [{ id: 'i1', form: 'perro', metadata: { gloss: 'dog', pos: 'N' } }],
      },
    ],
    options: {
      glossField: 'Gloss',
      glossScope: 'morpheme',
      translationField: 'Translation',
      commentField: 'Note',
      extras: { sentence: [], word: ['POS'], morpheme: [], orthographies: ['Translit'] },
      speakers: false,
      dictionary: true,
    },
  });
  const zipped = zipSync(Object.fromEntries(files.map((f) => [f.path, strToU8(f.data)])));
  return buildCldfDocuments(readCldfDataset(zipped));
}

const role = (r) => ({ plaid: { role: r } });
const scoped = (name, scope) => ({ id: `sl-${scope}-${name}`, name, config: { igt: { scope } } });

const PROJECT = {
  id: 'p1',
  vocabs: [{ id: 'v1', name: 'Lexicon' }],
  textLayers: [
    {
      id: 'tl1',
      config: role('baseline'),
      tokenLayers: [
        {
          id: 'word',
          config: role('word'),
          spanLayers: [scoped('POS', 'Word')],
        },
        { id: 'sent', config: role('sentence'), spanLayers: [scoped('Translation', 'Sentence')] },
        { id: 'morph', config: role('morpheme'), spanLayers: [scoped('Gloss', 'Morpheme')] },
      ],
    },
  ],
};

function stubClient({ existingDocs = [], existingItems = [] } = {}) {
  const calls = [];
  let n = 0;
  const id = (p) => `${p}-${++n}`;
  const record = (kind, args, result) => {
    calls.push({ kind, args });
    return Promise.resolve(result);
  };
  const docsById = new Map(existingDocs.map((d) => [d.id, d]));
  return {
    calls,
    withOperation: async (_message, fn) => fn(),
    projects: {
      get: () => Promise.resolve(PROJECT),
      listDocuments: () => Promise.resolve(existingDocs.map((d) => ({ id: d.id, name: d.name }))),
      setConfig: (projectId, ns, key, value) =>
        record('projects.setConfig', { projectId, ns, key, value }, {}),
    },
    documents: {
      create: (projectId, name, metadata) =>
        record('documents.create', { projectId, name, metadata }, { id: id('doc') }),
      get: (docId) => Promise.resolve(docsById.get(docId)),
      delete: (docId) => record('documents.delete', { docId }, {}),
      setMetadata: (docId, body) => record('documents.setMetadata', { docId, body }, {}),
      uploadMedia: (docId, file) => record('documents.uploadMedia', { docId, file }, {}),
    },
    texts: {
      create: (layerId, docId, body) =>
        record('texts.create', { layerId, docId, body }, { id: 'text-1' }),
    },
    tokens: {
      bulkCreate: (body) => record('tokens.bulkCreate', body, { ids: body.map(() => id('tok')) }),
    },
    spans: {
      bulkCreate: (body) => record('spans.bulkCreate', body, { ids: body.map(() => id('span')) }),
    },
    vocabLayers: {
      get: () => Promise.resolve({ id: 'v1', items: existingItems, config: {} }),
      setConfig: (vocabId, ns, key, value) =>
        record('vocabLayers.setConfig', { vocabId, ns, key, value }, {}),
    },
    vocabItems: {
      bulkCreate: (body) =>
        record('vocabItems.bulkCreate', { body }, { ids: body.map(() => id('item')) }),
    },
  };
}

const callsOf = (client, kind) => client.calls.filter((c) => c.kind === kind);
const tokenCalls = (client) => callsOf(client, 'tokens.bulkCreate').map((c) => c.args);

describe('deriveSetupData', () => {
  it('turns the derived schema into setup-wizard input', () => {
    const setup = deriveSetupData(fixtureBuild(), 'My Corpus');
    expect(setup.basicInfo.projectName).toBe('My Corpus');
    expect(setup.orthographies.orthographies).toEqual([
      { name: 'Baseline', isBaseline: true },
      { name: 'Translit' },
    ]);
    expect(setup.fields.fields).toEqual(
      expect.arrayContaining([
        { name: 'Translation', scope: 'Sentence', isCustom: true },
        { name: 'Gloss', scope: 'Morpheme', isCustom: true },
        { name: 'POS', scope: 'Word', isCustom: true },
      ]),
    );
    expect(setup.vocabulary.vocabularies).toHaveLength(1);
    expect(setup.documentMetadata.enabledFields.map((f) => f.name).sort()).toEqual([
      'Genre',
      'Source',
    ]);
  });

  it('asks for no vocabulary when the dataset has no lexicon', () => {
    const build = fixtureBuild();
    build.lexicon = [];
    expect(deriveSetupData(build, 'X').vocabulary.vocabularies).toEqual([]);
  });
});

describe('resolveTargets', () => {
  it('resolves the substrate layers and every field the build needs', () => {
    const targets = resolveTargets(PROJECT, fixtureBuild());
    expect(targets).toMatchObject({
      textLayerId: 'tl1',
      sentenceLayerId: 'sent',
      wordLayerId: 'word',
      morphemeLayerId: 'morph',
    });
    expect(targets.spanLayerByScopeName.get('Morpheme:Gloss')).toBe('sl-Morpheme-Gloss');
  });

  it('refuses when setup did not create a field the build needs', () => {
    const build = fixtureBuild();
    build.schema.fields.push({ name: 'Missing', scope: 'Word' });
    expect(() => resolveTargets(PROJECT, build)).toThrow(/Missing.*Word.*setup incomplete/);
  });

  it('refuses when the substrate is not set up', () => {
    expect(() => resolveTargets({ textLayers: [] }, fixtureBuild())).toThrow(/baseline text layer/);
  });
});

describe('runCldfImport', () => {
  it('writes the text, the sentence partition, words and morphemes', async () => {
    const client = stubClient();
    const build = fixtureBuild();
    const res = await runCldfImport({ client, projectId: 'p1', build });

    expect(res.imported).toBe(1);
    expect(callsOf(client, 'texts.create')[0].args.body).toBe('perros corren.');
    const [sentences, words, morphemes] = tokenCalls(client);
    expect(sentences).toEqual([{ tokenLayerId: 'sent', text: 'text-1', begin: 0, end: 14 }]);
    expect(words.map((w) => [w.begin, w.end])).toEqual([
      [0, 6],
      [7, 13],
    ]);
    // The orthography rides in token metadata, not in a span.
    expect(words[0].metadata).toEqual({ 'orthog:Translit': 'perros-translit' });
    expect(morphemes.map((m) => [m.precedence, m.metadata.form])).toEqual([
      [1, 'perro'],
      [2, 's'],
      [1, 'corren'],
    ]);
    expect(morphemes[1].metadata.morphType).toBe('enclitic');
  });

  it('gives every word a morpheme, so the IGT invariant holds on first open', async () => {
    const client = stubClient();
    const build = fixtureBuild();
    // A word the dataset never analyzed.
    build.documents[0].words.push({
      begin: 0,
      end: 6,
      sentenceIndex: 0,
      fields: {},
      morphemes: [],
    });
    await runCldfImport({ client, projectId: 'p1', build });
    const [, words, morphemes] = tokenCalls(client);
    expect(morphemes).toHaveLength(words.length + 1); // perro + s, corren, and the bare one
    expect(morphemes.at(-1).metadata).toEqual({ form: '' });
  });

  it('writes annotations into the span layer for their scope', async () => {
    const client = stubClient();
    await runCldfImport({ client, projectId: 'p1', build: fixtureBuild() });
    const spans = callsOf(client, 'spans.bulkCreate').flatMap((c) => c.args);
    const byLayer = (layer) => spans.filter((s) => s.spanLayerId === layer).map((s) => s.value);
    expect(byLayer('sl-Sentence-Translation')).toEqual(['The dogs run.']);
    expect(byLayer('sl-Morpheme-Gloss')).toEqual(['dog', 'PL']);
    expect(byLayer('sl-Word-POS')).toEqual(['NOUN', 'VERB']);
    // Every bulk call carries one layer only, which the endpoint requires.
    for (const call of callsOf(client, 'spans.bulkCreate')) {
      expect(new Set(call.args.map((s) => s.spanLayerId)).size).toBe(1);
    }
  });

  it('adopts the dataset language identity as project config', async () => {
    const client = stubClient();
    await runCldfImport({ client, projectId: 'p1', build: fixtureBuild() });
    const call = callsOf(client, 'projects.setConfig').find((c) => c.args.key === 'languages');
    expect(call.args.value.object).toMatchObject({ name: 'Spanish', glottocode: 'stan1288' });
    expect(call.args.value.meta).toMatchObject({ name: 'English', iso639P3: 'eng' });
  });

  it('imports the lexicon, stamping each item with its CLDF entry id', async () => {
    const client = stubClient();
    await runCldfImport({ client, projectId: 'p1', build: fixtureBuild() });
    const items = callsOf(client, 'vocabItems.bulkCreate').flatMap((c) => c.args.body);
    expect(items).toEqual([
      {
        vocabLayerId: 'v1',
        form: 'perro',
        metadata: { gloss: 'dog', pos: 'N', cldfEntry: 'e1' },
      },
    ]);
    const config = callsOf(client, 'vocabLayers.setConfig')[0];
    expect(Object.keys(config.args.value)).toEqual(
      expect.arrayContaining(['gloss', 'pos', 'definition', 'morphType']),
    );
  });

  it('reuses a lexicon item already stamped with the same entry id', async () => {
    const client = stubClient({
      existingItems: [{ id: 'old', form: 'perro', metadata: { cldfEntry: 'e1' } }],
    });
    await runCldfImport({ client, projectId: 'p1', build: fixtureBuild() });
    expect(callsOf(client, 'vocabItems.bulkCreate')).toHaveLength(0);
  });

  it('marks a document done only after every write succeeded', async () => {
    const client = stubClient();
    await runCldfImport({ client, projectId: 'p1', build: fixtureBuild() });
    const kinds = client.calls.map((c) => c.kind);
    expect(kinds.at(-1)).toBe('documents.setMetadata');
    expect(callsOf(client, 'documents.setMetadata')[0].args.body.cldfImported).toBe(true);
  });

  it('skips a document already marked done and redoes a half-imported one', async () => {
    const done = { id: 'd-done', name: 'Test & Doc', metadata: { cldfImported: true } };
    const skipClient = stubClient({ existingDocs: [done] });
    const skipped = await runCldfImport({
      client: skipClient,
      projectId: 'p1',
      build: fixtureBuild(),
    });
    expect(skipped).toMatchObject({ imported: 0, skipped: 1 });
    expect(callsOf(skipClient, 'documents.create')).toHaveLength(0);

    const partial = { id: 'd-partial', name: 'Test & Doc', metadata: {} };
    const redoClient = stubClient({ existingDocs: [partial] });
    const redone = await runCldfImport({
      client: redoClient,
      projectId: 'p1',
      build: fixtureBuild(),
    });
    expect(redone).toMatchObject({ imported: 1, redone: 1 });
    expect(callsOf(redoClient, 'documents.delete')[0].args.docId).toBe('d-partial');
  });

  it('stops promptly when asked, without marking the document done', async () => {
    const client = stubClient();
    await expect(
      runCldfImport({
        client,
        projectId: 'p1',
        build: fixtureBuild(),
        shouldStop: () => true,
      }),
    ).rejects.toThrow(/cancelled/i);
    expect(callsOf(client, 'documents.setMetadata')).toHaveLength(0);
  });

  it('reports the document index on every step, so the counter can advance', async () => {
    const client = stubClient();
    const build = fixtureBuild();
    // Two documents, so a stuck counter would show as every event saying 0.
    build.documents.push({ ...build.documents[0], name: 'Second' });
    const events = [];
    await runCldfImport({
      client,
      projectId: 'p1',
      build,
      onProgress: (p) => p.phase === 'document' && events.push(p),
    });
    expect(events.length).toBeGreaterThan(4);
    expect(events.every((e) => Number.isInteger(e.index) && e.total === 2)).toBe(true);
    expect([...new Set(events.map((e) => e.index))]).toEqual([0, 1]);
    // And the fraction only ever moves forward.
    const f = events.map((e) => documentFraction(e));
    expect(f.every((v, i) => i === 0 || v >= f[i - 1])).toBe(true);
    expect(new Set(f).size).toBeGreaterThan(2);
  });

  it('carries the build warnings through to the result', async () => {
    const client = stubClient();
    const build = fixtureBuild();
    build.warnings.push('something to say');
    build.documents[0].warnings.push('per-document note');
    const res = await runCldfImport({ client, projectId: 'p1', build });
    expect(res.warnings).toEqual(expect.arrayContaining(['something to say', 'per-document note']));
  });

  it('leaves a document unfinished when its media upload fails, so a retry redoes it', async () => {
    const client = stubClient();
    client.documents.uploadMedia = () => Promise.reject(new Error('nope'));
    const build = fixtureBuild();
    build.documents[0].mediaBytes = new Uint8Array([1, 2, 3]);
    build.documents[0].mediaName = 'a.wav';
    const res = await runCldfImport({ client, projectId: 'p1', build });
    expect(res.warnings.join(' ')).toMatch(/media upload failed/);
    expect(callsOf(client, 'documents.setMetadata')).toHaveLength(0);
  });
});
