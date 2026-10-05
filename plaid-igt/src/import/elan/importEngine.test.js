import { describe, it, expect } from 'vitest';
import {
  deriveSetupData,
  resolveTargets,
  importDocument,
  runElanImport,
  ImportCancelled,
} from './importEngine.js';
import { defaultIgnoredTokensSetup } from '../../domain/igtConfig.js';

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

// `docMedia` names the documents that already have a recording.
function stubClient({ documents = [], docMetadata = {}, docMedia = [] } = {}) {
  const calls = [];
  let seq = 0;
  const next = (prefix) => `${prefix}${++seq}`;
  return {
    calls,
    withOperation: (_name, fn) => fn(),
    projects: {
      get: async () => PROJECT,
      listDocuments: async () => documents,
      setConfig: async (projectId, ns, key, value) =>
        calls.push(['projects.setConfig', projectId, ns, key, value]),
    },
    documents: {
      // The id the client names, as core takes it.
      create: async (projectId, name, metadata, _message, { id } = {}) => {
        calls.push(['documents.create', name, metadata, id]);
        return { id };
      },
      get: async (id) => ({
        id,
        metadata: docMetadata[id] ?? {},
        ...(docMedia.includes(id) ? { mediaUrl: `/media/${id}` } : {}),
      }),
      delete: async (id) => calls.push(['documents.delete', id]),
      setMetadata: async (id, metadata) => calls.push(['documents.setMetadata', id, metadata]),
      uploadMedia: async (id, file) => calls.push(['documents.uploadMedia', id, file.name]),
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
      { name: 'Translation', scope: 'Sentence', lang: null, isCustom: true },
      { name: 'POS', scope: 'Word', lang: null, isCustom: true },
      { name: 'Gloss', scope: 'Morpheme', lang: null, isCustom: true },
    ]);
    expect(setup.fields.ignoredTokens).toEqual(defaultIgnoredTokensSetup());
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
    // Morphemes span the whole word. The word the .eaf never segmented (0-3)
    // gets no row at all: derive gives it one reading as the word.
    expect(morphemes).toEqual([
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
    const [, , begun, id] = client.calls.find(([m]) => m === 'documents.create');
    expect(begun).toEqual({ Source: 'notes', importSource: `${id}:a.eaf` });
    expect(last[0]).toBe('documents.setMetadata');
    expect(last[1]).toBe(id);
    expect(last[2]).toEqual({ Source: 'notes', importSource: `${id}:a.eaf`, importDone: true });
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
    expect(warnings[0]).toMatch(/not set up for time alignment/);
    expect(tokenCalls(client)).toHaveLength(3); // sentences, words, morphemes
  });
  it('writes no form for a morpheme that has none, so it reads as its word', async () => {
    const client = stubClient();
    const doc = {
      ...BUILD.documents[0],
      words: [
        {
          begin: 0,
          end: 3,
          sentenceIndex: 0,
          fields: {},
          morphemes: [{ form: null, morphType: null, fields: { Gloss: 'DET' } }],
        },
      ],
    };
    await importDocument({
      client,
      projectId: 'p1',
      targets: resolveTargets(PROJECT, BUILD),
      doc,
      warnings: [],
    });
    expect(tokenCalls(client)[3]).toEqual([
      { tokenLayerId: 'ml', text: 'text1', begin: 0, end: 3, precedence: 1, metadata: {} },
    ]);
  });
});

describe('runElanImport', () => {
  // A study reads the audit log: the import is one operation of kind import,
  // naming the format it read.
  it('is one import operation naming its format', async () => {
    const opts = [];
    const tagged = (client) => {
      const run = client.withOperation;
      client.withOperation = (message, fn, o) => {
        opts.push(o);
        return run(message, fn);
      };
      return client;
    };
    await runElanImport({ client: tagged(stubClient()), projectId: 'p1', build: BUILD });
    expect(opts).toEqual([{ kind: 'import', ref: 'format:elan' }]);
  });

  it('imports every document and reports the tally', async () => {
    const client = stubClient();
    const result = await runElanImport({ client, projectId: 'p1', build: BUILD });
    expect(result).toMatchObject({ imported: 1, skipped: 0, redone: 0 });
  });

  // The screens count documents off `index`, so a step that left it out read
  // as the first document: "(1/23)" through the whole run.
  it('says which document every step belongs to', async () => {
    const second = { ...BUILD.documents[0], id: 'b.eaf', name: 'Second' };
    const build = { ...BUILD, documents: [BUILD.documents[0], second] };
    const seen = [];
    await runElanImport({
      client: stubClient(),
      projectId: 'p1',
      build,
      onProgress: (p) => p.phase === 'document' && seen.push(p),
    });
    const steps = seen.filter((p) => p.doc === 'Second');
    expect(steps.length).toBeGreaterThan(1);
    expect(steps.every((p) => p.index === 1 && p.total === 2)).toBe(true);
  });

  it('reports each warning as it happens, tagged with its document', async () => {
    const client = stubClient();
    const seen = [];
    const build = {
      ...BUILD,
      warnings: ['A corpus-wide note.'],
      documents: [{ ...BUILD.documents[0], warnings: ['Utterance 1: something odd.'] }],
    };
    const res = await runElanImport({
      client,
      projectId: 'p1',
      build,
      onWarning: (text, meta) => seen.push([text, meta.document]),
    });
    // Streamed in order, the corpus-wide one before any document's.
    expect(seen).toEqual([
      ['A corpus-wide note.', null],
      ['Utterance 1: something odd.', 'Story'],
    ]);
    // And the returned tally still holds every one of them.
    expect(res.warnings).toEqual(['A corpus-wide note.', 'Utterance 1: something odd.']);
  });

  it('skips a document already marked done and redoes a half-imported one', async () => {
    const done = stubClient({
      documents: [{ id: 'old', name: 'Story' }],
      docMetadata: { old: { importSource: 'old:a.eaf', importDone: true } },
    });
    expect(await runElanImport({ client: done, projectId: 'p1', build: BUILD })).toMatchObject({
      imported: 0,
      skipped: 1,
    });
    expect(done.calls.some(([m]) => m === 'documents.create')).toBe(false);

    const partial = stubClient({
      documents: [{ id: 'old', name: 'Story' }],
      docMetadata: { old: { importSource: 'old:a.eaf' } },
    });
    expect(await runElanImport({ client: partial, projectId: 'p1', build: BUILD })).toMatchObject({
      imported: 1,
      redone: 1,
    });
    expect(partial.calls[0]).toEqual(['documents.delete', 'old']);
  });

  // The screen names what an earlier run already imported and offers to import
  // it again; without this the skip was invisible until the tally, and there
  // was no way to ask for the document to be made afresh.
  it('replaces a document already marked done when the run asks it to', async () => {
    const client = stubClient({
      documents: [{ id: 'old', name: 'Story' }],
      docMetadata: { old: { importSource: 'old:a.eaf', importDone: true } },
    });
    expect(
      await runElanImport({ client, projectId: 'p1', build: BUILD, priorMode: 'replace' }),
    ).toMatchObject({ imported: 1, skipped: 0, redone: 1 });
    expect(client.calls[0]).toEqual(['documents.delete', 'old']);
  });

  // The first real user wanted a second copy of a document to play with, and
  // the screen offered only to keep the first or delete it.
  describe('a copy beside a document already there', () => {
    const prior = {
      documents: [
        { id: 'old', name: 'Story' },
        { id: 'other', name: 'Story (2)' },
      ],
      docMetadata: { old: { importSource: 'old:a.eaf', importDone: true } },
    };

    it('is a new document with the next free name, and the original is untouched', async () => {
      const client = stubClient(prior);
      const res = await runElanImport({ client, projectId: 'p1', build: BUILD, priorMode: 'copy' });
      expect(res).toMatchObject({ imported: 0, skipped: 0, redone: 0, copied: 1 });
      expect(client.calls.some(([m]) => m === 'documents.delete')).toBe(false);
      const create = client.calls.find(([m]) => m === 'documents.create');
      expect(create[1]).toBe('Story (3)');
    });

    it('carries no resume stamp, so a later run never takes it for the original', async () => {
      const client = stubClient(prior);
      await runElanImport({ client, projectId: 'p1', build: BUILD, priorMode: 'copy' });
      const create = client.calls.find(([m]) => m === 'documents.create');
      expect(create[2]).toEqual({ Source: 'notes' });
      expect(client.calls.some(([m]) => m === 'documents.setMetadata')).toBe(false);
    });

    it('drops a header property named like a resume stamp', async () => {
      // Carried onto the copy, `importSource: "a.eaf"` would make the next run
      // of a.eaf find the copy, take it for half made and delete it.
      const client = stubClient(prior);
      const build = {
        ...BUILD,
        documents: [
          {
            ...BUILD.documents[0],
            metadata: { Source: 'notes', importSource: 'a.eaf', importDone: true },
          },
        ],
      };
      await runElanImport({ client, projectId: 'p1', build, priorMode: 'copy' });
      const create = client.calls.find(([m]) => m === 'documents.create');
      expect(create[2]).toEqual({ Source: 'notes' });
    });

    it('still redoes a document an earlier run left half done', async () => {
      const client = stubClient({
        documents: [{ id: 'old', name: 'Story' }],
        docMetadata: { old: { importSource: 'old:a.eaf' } },
      });
      const res = await runElanImport({ client, projectId: 'p1', build: BUILD, priorMode: 'copy' });
      expect(res).toMatchObject({ imported: 1, redone: 1, copied: 0 });
      expect(client.calls[0]).toEqual(['documents.delete', 'old']);
    });
  });

  // A recording is uploaded as part of creating a document, so one chosen
  // beside a skipped file went nowhere, and nothing said so.
  describe('the recording of a skipped file', () => {
    const wav = { name: 'a.wav' };
    const withWav = { ...BUILD, documents: [{ ...BUILD.documents[0], mediaFile: wav }] };
    const prior = {
      documents: [{ id: 'old', name: 'Story' }],
      docMetadata: { old: { importSource: 'old:a.eaf', importDone: true } },
    };

    it('is added to the existing document when it has none', async () => {
      const client = stubClient(prior);
      const res = await runElanImport({ client, projectId: 'p1', build: withWav });
      expect(res).toMatchObject({ skipped: 1, recordingsAdded: 1, recordingsUnused: 0 });
      expect(client.calls).toContainEqual(['documents.uploadMedia', 'old', 'a.wav']);
      expect(client.calls.some(([m]) => m === 'documents.create')).toBe(false);
    });

    it('is left unused when the existing document already has one, and counted', async () => {
      const client = stubClient({ ...prior, docMedia: ['old'] });
      const res = await runElanImport({ client, projectId: 'p1', build: withWav });
      expect(res).toMatchObject({ skipped: 1, recordingsAdded: 0, recordingsUnused: 1 });
      expect(client.calls.some(([m]) => m === 'documents.uploadMedia')).toBe(false);
    });

    it('is a warning, not a failure, when the upload breaks', async () => {
      const client = stubClient(prior);
      client.documents.uploadMedia = async () => {
        throw new Error('disk full');
      };
      const res = await runElanImport({ client, projectId: 'p1', build: withWav });
      expect(res).toMatchObject({ skipped: 1, recordingsAdded: 0 });
      expect(res.warnings.join(' ')).toMatch(/could not be added.*disk full/);
    });
  });

  // A corpus prepared for FieldWorks names its tiers `Transcription-txt-oni`
  // and `Translation-gls-nl`, so the import knows both languages and the
  // export screen should not start at `und` and `en`.
  it("records the project's languages from what the tier names declare", async () => {
    const client = stubClient();
    const build = {
      ...BUILD,
      schema: {
        ...BUILD.schema,
        baselineLang: 'oni',
        fields: [
          { name: 'Translation', scope: 'Sentence', lang: 'pmy' },
          { name: 'Gloss', scope: 'Morpheme', lang: 'pmy' },
        ],
      },
    };
    await runElanImport({ client, projectId: 'p1', build });
    const call = client.calls.find(([m]) => m === 'projects.setConfig');
    expect(call.slice(1, 4)).toEqual(['p1', 'igt', 'languages']);
    expect(call[4].object.iso639P3).toBe('oni');
    expect(call[4].meta.iso639P3).toBe('pmy');
  });

  it('records nothing when the tier names declare nothing', async () => {
    const client = stubClient();
    await runElanImport({ client, projectId: 'p1', build: BUILD });
    expect(client.calls.some(([m]) => m === 'projects.setConfig')).toBe(false);
  });

  // N3-IMPORT-OVER-1: Add documents deleted a document an earlier run left
  // unfinished (a failed recording upload, a Stop) with every gloss and
  // translation a person had added to it, and listed the file as new.
  describe('into a project open for work', () => {
    const wav = { name: 'a.wav' };
    const withWav = { ...BUILD, documents: [{ ...BUILD.documents[0], mediaFile: wav }] };
    const unfinished = {
      documents: [{ id: 'old', name: 'Story' }],
      docMetadata: { old: { importSource: 'old:a.eaf' } },
    };
    const open = (client, extra = {}) =>
      runElanImport({ client, projectId: 'p1', build: withWav, projectOpen: true, ...extra });

    it('keeps an unfinished document by default, and gives it the recording', async () => {
      const client = stubClient(unfinished);
      const res = await open(client);
      expect(res).toMatchObject({ imported: 0, skipped: 1, redone: 0, recordingsAdded: 1 });
      expect(client.calls.some(([m]) => m === 'documents.delete')).toBe(false);
      expect(client.calls.some(([m]) => m === 'documents.create')).toBe(false);
      expect(client.calls).toContainEqual(['documents.uploadMedia', 'old', 'a.wav']);
    });

    it('replaces it when the person says Replace', async () => {
      const client = stubClient(unfinished);
      expect(await open(client, { priorMode: 'replace' })).toMatchObject({
        imported: 1,
        redone: 1,
      });
      expect(client.calls[0]).toEqual(['documents.delete', 'old']);
    });

    it('adds a copy beside it when the person says Add copies', async () => {
      const client = stubClient(unfinished);
      expect(await open(client, { priorMode: 'copy' })).toMatchObject({ copied: 1, redone: 0 });
      expect(client.calls.some(([m]) => m === 'documents.delete')).toBe(false);
    });

    it('removes the document a stopped run was making, and says so', async () => {
      const client = stubClient();
      let stop = false;
      client.tokens.bulkCreate = async () => {
        stop = true;
        return { ids: [] };
      };
      const err = await open(client, { shouldStop: () => stop }).catch((e) => e);
      expect(err).toBeInstanceOf(ImportCancelled);
      expect(err.unfinishedRemoved).toBe(true);
      const [, , , made] = client.calls.find(([m]) => m === 'documents.create');
      expect(client.calls).toContainEqual(['documents.delete', made]);
    });

    // REV-N5-APPS R2: a cleanup delete that failed too left an empty
    // document, which the retry then kept as if someone had worked on it.
    it('names the document it could not remove, and a retry redoes it', async () => {
      const client = stubClient();
      let stop = false;
      client.tokens.bulkCreate = async () => {
        stop = true;
        return { ids: [] };
      };
      client.documents.delete = async () => {
        throw new Error('offline');
      };
      const err = await open(client, { shouldStop: () => stop }).catch((e) => e);
      expect(err.unfinishedRemoved).toBe(false);
      const [, , , made] = client.calls.find(([m]) => m === 'documents.create');
      expect(err.unfinishedLeft).toEqual({ id: made, name: 'Story' });

      const retry = stubClient({
        documents: [{ id: made, name: 'Story' }],
        docMetadata: { [made]: { importSource: `${made}:a.eaf` } },
      });
      const res = await open(retry, { redo: [made] });
      expect(res).toMatchObject({ imported: 1, redone: 1, skipped: 0 });
      expect(retry.calls[0]).toEqual(['documents.delete', made]);
    });

    it('still keeps an unfinished document a retry was not told to redo', async () => {
      const client = stubClient(unfinished);
      expect(await open(client, { redo: ['someone-else'] })).toMatchObject({ skipped: 1 });
      expect(client.calls.some(([m]) => m === 'documents.delete')).toBe(false);
    });

    it('leaves it in place on a resume, which redoes it', async () => {
      const client = stubClient();
      let stop = false;
      client.tokens.bulkCreate = async () => {
        stop = true;
        return { ids: [] };
      };
      await expect(
        runElanImport({ client, projectId: 'p1', build: BUILD, shouldStop: () => stop }),
      ).rejects.toBeInstanceOf(ImportCancelled);
      expect(client.calls.some(([m]) => m === 'documents.delete')).toBe(false);
    });

    it('points a failed recording upload to the Media tab', async () => {
      const client = stubClient();
      client.documents.uploadMedia = async () => {
        throw new Error('disk full');
      };
      const res = await open(client);
      expect(res.warnings.join(' ')).toMatch(
        /media upload failed\..*Upload the recording on the document's Media tab\./,
      );
    });
  });

  it('stops when asked', async () => {
    const client = stubClient();
    await expect(
      runElanImport({ client, projectId: 'p1', build: BUILD, shouldStop: () => true }),
    ).rejects.toBeInstanceOf(ImportCancelled);
  });
});
