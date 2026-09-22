import { describe, it, expect } from 'vitest';
import { IgtDocument } from '../../domain/IgtDocument.js';
import {
  buildProjectFile,
  serializeVocabularyNative,
  serializeDocumentNative,
} from '../../export/nativeJson.js';
import {
  makeNativeRaw,
  makeNativeProject,
  makeOtherAppRaw,
  makeOtherAppProject,
} from '../../export/testFixtures.js';
import { CHUNK } from '../bulk.js';
import { importOtherLayerData, noOtherLayers } from './otherLayers.js';
import {
  deriveSetupData,
  resolveNativeTargets,
  importVocabulary,
  planVocabRelink,
  runNativeImport,
  rebuildTokenMap,
} from './importEngine.js';

// ---- the archive under test: built by the REAL exporter --------------------
// Export the loss-trap fixture document, then import the result — the test is
// the exporter↔importer contract itself.

const VOCAB = {
  id: 'vocab1',
  name: 'Lex',
  config: { igt: { fields: { gloss: { inline: true } } } },
  items: [
    { id: 'item1', form: 'perro', metadata: { gloss: 'dog' } },
    { id: 'item2', form: 'perro', metadata: { gloss: 'dog2' } },
    { id: 'item3', form: 'np', metadata: {} },
  ],
};

function buildArchive() {
  const project = makeNativeProject();
  const igtDoc = new IgtDocument({ raw: makeNativeRaw(), project, vocabularies: {} });
  const docData = serializeDocumentNative(igtDoc, { mediaFile: 'media/Doc One.wav' });
  return {
    manifest: buildProjectFile({
      project,
      documents: [
        {
          id: 'doc1',
          name: 'Doc One',
          file: 'documents/Doc One.json',
          mediaFile: 'media/Doc One.wav',
        },
      ],
      vocabularies: [{ id: 'vocab1', name: 'Lex', file: 'vocabularies/Lex.json' }],
      exportedAt: '2026-06-12T00:00:00.000Z',
    }),
    vocabularies: [
      {
        id: 'vocab1',
        name: 'Lex',
        file: 'vocabularies/Lex.json',
        data: serializeVocabularyNative(VOCAB),
      },
    ],
    documents: [
      {
        id: 'doc1',
        name: 'Doc One',
        file: 'documents/Doc One.json',
        mediaFile: 'media/Doc One.wav',
        data: serializeDocumentNative(igtDoc, { mediaFile: 'media/Doc One.wav' }),
        mediaBytes: new Uint8Array([1, 2, 3]),
      },
    ],
    docData,
  };
}

// ---- stub client ------------------------------------------------------------
// The "project" it returns is the target project AFTER setup ran: fresh layer
// ids (prefixed new-) so old≠new is actually exercised.

function targetProject() {
  const p = JSON.parse(JSON.stringify(makeNativeProject()));
  p.id = 'newp';
  p.vocabs = [{ id: 'newvocab', name: 'Lex' }];
  const walk = (layers) =>
    layers.forEach((l) => {
      l.id = `new-${l.id}`;
      (l.tokenLayers || []).forEach((tl) => {
        tl.id = `new-${tl.id}`;
        tl.tokens = [];
        tl.vocabs = [];
        (tl.spanLayers || []).forEach((sl) => {
          sl.id = `new-${sl.id}`;
          sl.spans = [];
        });
      });
    });
  walk(p.textLayers);
  return p;
}

function stubClient({
  existingDocs = [],
  existingItems = [],
  existingVocabComments = [],
  // What the server says of a token layer that a project read leaves out.
  tokenLayerShapes = {},
} = {}) {
  const calls = [];
  const written = new Map();
  let batch = null;
  let nextId = 0;
  const fresh = (prefix) => `${prefix}-${nextId++}`;
  // Each call keeps what it answered, out of sight of toEqual, so a test can
  // follow an id from the call that made it to the calls that use it.
  const record = (name, args, result) => {
    const entry = [name, ...args];
    Object.defineProperty(entry, 'result', { value: result, enumerable: false });
    calls.push(entry);
    return result;
  };
  const client = {
    calls,
    projects: {
      get: async (id) => record('projects.get', [id], targetProject()),
      setConfig: async (...a) => record('projects.setConfig', a),
      listDocuments: async (id) => record('projects.listDocuments', [id], existingDocs),
    },
    vocabLayers: {
      get: async (id) => record('vocabLayers.get', [id], { id, items: existingItems }),
      setConfig: async (...a) => record('vocabLayers.setConfig', a),
      deleteConfig: async (...a) => record('vocabLayers.deleteConfig', a),
    },
    spanLayers: {
      create: async (...a) => record('spanLayers.create', a, { id: fresh('sl') }),
      setConfig: async (...a) => record('spanLayers.setConfig', a),
    },
    textLayers: {
      setConfig: async (...a) => record('textLayers.setConfig', a),
    },
    tokenLayers: {
      create: async (...a) => record('tokenLayers.create', a, { id: fresh('tl') }),
      setConfig: async (...a) => record('tokenLayers.setConfig', a),
      get: async (id) => record('tokenLayers.get', [id], { id, ...tokenLayerShapes[id] }),
    },
    relationLayers: {
      create: async (...a) => record('relationLayers.create', a, { id: fresh('rl') }),
      setConfig: async (...a) => record('relationLayers.setConfig', a),
    },
    relations: {
      bulkCreate: async (specs) =>
        record('relations.bulkCreate', [specs], { ids: specs.map(() => fresh('rel')) }),
      bulkUpdate: async (rows) => record('relations.bulkUpdate', [rows], { count: rows.length }),
    },
    guidelines: {
      create: async (...a) => record('guidelines.create', a, { id: fresh('gl') }),
      // A new project has none; a resume's project has what the first run
      // wrote, which the tests below stand in for.
      list: async () => [],
    },
    vocabItems: {
      bulkCreate: async (body) =>
        record('vocabItems.bulkCreate', [body], { ids: body.map(() => fresh('item')) }),
      setMetadata: async (...a) => record('vocabItems.setMetadata', a),
      bulkUpdate: async (body) => record('vocabItems.bulkUpdate', [body], { count: body.length }),
      deleteMetadata: async (...a) => record('vocabItems.deleteMetadata', a),
    },
    vocabLinks: {
      create: (itemId, tokens, metadata) => {
        const result = { id: fresh('link') };
        record('vocabLinks.create', [itemId, tokens, metadata], result);
        if (batch) batch.push(result);
        return result;
      },
      bulkCreate: (body) =>
        record('vocabLinks.bulkCreate', [body], { ids: body.map(() => fresh('link')) }),
    },
    withOperation: async (_message, fn) => fn(() => {}),
    // A batch: a view of the client whose writes queue, handed to `fn` the way
    // the real client hands one over. This fake records a write the same way on
    // either, so the view is the client itself.
    batched: async (fn) => {
      batch = [];
      try {
        await fn(client);
        return batch;
      } finally {
        batch = null;
      }
    },
    // Documents this import made keep the metadata written to them, so a read
    // answers what the server would.
    documents: {
      create: async (projectId, name, metadata) => {
        const made = record('documents.create', [projectId, name, metadata], { id: fresh('doc') });
        written.set(made.id, { id: made.id, name, metadata });
        return made;
      },
      get: async (id) =>
        record(
          'documents.get',
          [id],
          existingDocs.find((d) => d.id === id) ?? written.get(id) ?? { id, metadata: {} },
        ),
      delete: async (id) => record('documents.delete', [id]),
      setMetadata: async (id, metadata) => {
        if (written.has(id)) written.get(id).metadata = metadata;
        return record('documents.setMetadata', [id, metadata]);
      },
      patchMetadata: async (...a) => record('documents.patchMetadata', a),
      uploadMedia: async (id, file) => record('documents.uploadMedia', [id, file?.name]),
    },
    texts: {
      create: async (...a) => record('texts.create', a, { id: fresh('text') }),
      patchMetadata: async (...a) => record('texts.patchMetadata', a),
    },
    tokens: {
      bulkCreate: async (specs) =>
        record('tokens.bulkCreate', [specs], { ids: specs.map(() => fresh('tok')) }),
      bulkUpdate: async (rows) => record('tokens.bulkUpdate', [rows], { count: rows.length }),
    },
    spans: {
      bulkCreate: async (specs) =>
        record('spans.bulkCreate', [specs], { ids: specs.map(() => fresh('span')) }),
      bulkUpdate: async (rows) => record('spans.bulkUpdate', [rows], { count: rows.length }),
    },
    comments: {
      create: (entityType, entityId, body) => {
        const result = { id: fresh('comment') };
        record('comments.create', [entityType, entityId, body], result);
        if (batch) batch.push(result);
        return result;
      },
      listInVocab: async (vocabId) =>
        record('comments.listInVocab', [vocabId], existingVocabComments),
    },
  };
  return client;
}

const callsOf = (client, name) => client.calls.filter(([n]) => n === name);
const argsOf = (client, name) => callsOf(client, name).map((c) => c.slice(1));

// A vocab bulkCreate carries many entries in one call; flatten them back to
// per-item records so the assertions below stay item-shaped.
const createdItems = (client) =>
  callsOf(client, 'vocabItems.bulkCreate').flatMap(([, body]) => body);

// The same for the relink's bulk updates: the {id, metadata} entries it sent,
// where `metadata` is a PATCH against what the item was created with.
const itemPatches = (client) =>
  callsOf(client, 'vocabItems.bulkUpdate').flatMap(([, body]) => body);

describe('deriveSetupData', () => {
  it('maps the archive schema onto the setup wizard input', () => {
    const { manifest } = buildArchive();
    const setup = deriveSetupData(manifest, 'Reimported');
    expect(setup.basicInfo).toEqual({ projectName: 'Reimported' });
    expect(setup.orthographies.orthographies).toEqual([
      { name: 'Baseline', isBaseline: true },
      { name: 'Translit' },
    ]);
    expect(setup.fields.fields).toEqual(
      expect.arrayContaining([
        { name: 'Translation', scope: 'Sentence', lang: null, isCustom: true },
        { name: 'POS', scope: 'Word', lang: null, isCustom: true },
        { name: 'Phrase', scope: 'Word', lang: null, isCustom: true },
        { name: 'Gloss', scope: 'Morpheme', lang: null, isCustom: true },
      ]),
    );
    // A field's recorded language comes back with it, for setup to stamp.
    const labelled = {
      ...manifest,
      schema: {
        ...manifest.schema,
        fields: { ...manifest.schema.fields, sentence: [{ name: 'Translation', lang: 'pmy' }] },
      },
    };
    expect(deriveSetupData(labelled, 'x').fields.fields).toContainEqual({
      name: 'Translation',
      scope: 'Sentence',
      lang: 'pmy',
      isCustom: true,
    });
    expect(setup.fields.ignoredTokens).toBeUndefined(); // archive has null
    expect(setup.vocabulary.vocabularies).toEqual([
      { id: 'new-vocab1', name: 'Lex', enabled: true, isCustom: true },
    ]);
    expect(setup.documentMetadata.enabledFields).toEqual([
      { name: 'Source', enabled: true, isCustom: true },
    ]);
  });

  it('maps both ignoredTokens shapes', () => {
    const base = buildArchive().manifest;
    const withWl = {
      ...base,
      schema: { ...base.schema, ignoredTokens: { type: 'unicodePunctuation', whitelist: ['-'] } },
    };
    expect(deriveSetupData(withWl, 'x').fields.ignoredTokens).toEqual({
      mode: 'unicode-punctuation',
      unicodePunctuationExceptions: ['-'],
    });
    const withBl = {
      ...base,
      schema: { ...base.schema, ignoredTokens: { type: 'blacklist', blacklist: ['.'] } },
    };
    expect(deriveSetupData(withBl, 'x').fields.ignoredTokens).toEqual({
      mode: 'explicit',
      explicitIgnoredTokens: ['.'],
    });
  });
});

describe('importVocabulary', () => {
  it('creates items in array order, stamped with their archive id', async () => {
    const client = stubClient();
    const map = await importVocabulary({
      client,
      vocabId: 'newvocab',
      vocabData: serializeVocabularyNative(VOCAB),
    });
    const creates = createdItems(client);
    expect(creates.map((c) => c.form)).toEqual(['perro', 'perro', 'np']); // archive order
    expect(creates[0].metadata).toEqual({ gloss: 'dog', nativeImportId: 'item1' });
    expect(creates[0].vocabLayerId).toBe('newvocab');
    expect(map.get('item1')).toMatch(/^item-/);
    expect(map.size).toBe(3);
    // field schema written
    expect(callsOf(client, 'vocabLayers.setConfig')[0].slice(1)).toEqual([
      'newvocab',
      'igt',
      'fields',
      expect.objectContaining({ gloss: { inline: true } }),
    ]);
  });

  it("writes each field's tagset / lang and the vocabulary's tagsets before the items", async () => {
    const tagsets = { POS: { delimiters: '', mode: 'closed', values: [{ value: 'n' }] } };
    const client = stubClient();
    await importVocabulary({
      client,
      vocabId: 'newvocab',
      vocabData: serializeVocabularyNative({
        ...VOCAB,
        config: {
          igt: {
            fields: { pos: { inline: true, tagset: 'POS' }, Plural: { inline: false, lang: 'ru' } },
            tagsets,
          },
        },
      }),
    });
    const configs = callsOf(client, 'vocabLayers.setConfig').map((c) => c.slice(1));
    expect(configs).toEqual([
      [
        'newvocab',
        'igt',
        'fields',
        {
          morphType: { inline: false },
          gloss: { inline: true },
          pos: { inline: true, tagset: 'POS' },
          Plural: { inline: false, lang: 'ru' },
        },
      ],
      ['newvocab', 'igt', 'tagsets', tagsets],
    ]);
    // Both land before the first item is created.
    const order = client.calls.map((c) => c[0]);
    expect(order.lastIndexOf('vocabLayers.setConfig')).toBeLessThan(
      order.indexOf('vocabItems.bulkCreate'),
    );
  });

  it('resumes by nativeImportId without duplicating', async () => {
    const client = stubClient({
      existingItems: [{ id: 'kept', form: 'perro', metadata: { nativeImportId: 'item1' } }],
    });
    const map = await importVocabulary({
      client,
      vocabId: 'newvocab',
      vocabData: serializeVocabularyNative(VOCAB),
    });
    expect(map.get('item1')).toBe('kept');
    expect(createdItems(client)).toHaveLength(2);
  });
});

describe('importVocabulary — entry comments', () => {
  const comment = (over = {}) => ({
    id: 'c1',
    entityType: 'vocab-item',
    entityId: 'item1',
    anchorLabel: 'perro · dog',
    author: { id: 'honestlyada@aol.com', name: 'Ada Lovelace' },
    body: 'Also a verb?',
    createdAt: '2026-08-14T09:31:07Z',
    updatedAt: '2026-08-14T09:31:07Z',
    ...over,
  });
  const NOTE =
    '> Imported from an archive. Originally posted by Ada Lovelace <honestlyada@aol.com> on 2026-08-14.\n\n';

  async function runWith(comments, overrides = {}) {
    const client = stubClient(overrides);
    const warnings = [];
    const map = await importVocabulary({
      client,
      vocabId: 'newvocab',
      vocabData: serializeVocabularyNative(VOCAB, { comments }),
      warnings,
    });
    return { client, map, warnings, posted: callsOf(client, 'comments.create') };
  }

  it('reads nothing back and posts nothing when the vocabulary carries no comments', async () => {
    const { client, posted } = await runWith([]);
    expect(posted).toEqual([]);
    expect(callsOf(client, 'comments.listInVocab')).toEqual([]);
  });

  it('posts each comment against the entry the import created, with its attribution', async () => {
    const { map, posted, warnings } = await runWith([
      comment(),
      comment({ id: 'c2', entityId: 'item3', body: 'Phrase?' }),
    ]);
    expect(posted).toEqual([
      ['comments.create', 'vocab-item', map.get('item1'), `${NOTE}Also a verb?`],
      ['comments.create', 'vocab-item', map.get('item3'), `${NOTE}Phrase?`],
    ]);
    expect(map.get('item1')).toMatch(/^item-/);
    expect(warnings).toEqual([]);
  });

  it('does not post again a comment already on the vocabulary from an earlier run', async () => {
    const { posted, warnings } = await runWith([comment()], {
      existingItems: [{ id: 'kept', form: 'perro', metadata: { nativeImportId: 'item1' } }],
      existingVocabComments: [{ id: 'x', entityId: 'kept', body: `${NOTE}Also a verb?` }],
    });
    expect(posted).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it('warns and skips when the entry did not survive', async () => {
    // The exporter drops such a comment, so this is an archive edited by hand.
    const client = stubClient();
    const warnings = [];
    await importVocabulary({
      client,
      vocabId: 'newvocab',
      vocabData: {
        ...serializeVocabularyNative(VOCAB),
        comments: [
          { id: 'c9', anchor: { type: 'vocab-item', id: 'nosuch' }, body: 'x', author: {} },
        ],
      },
      warnings,
    });
    expect(callsOf(client, 'comments.create')).toEqual([]);
    expect(warnings).toEqual(['"Lex": comment c9 skipped (its entry did not survive the import)']);
  });

  it('runs as part of a full archive import, before the documents', async () => {
    const archive = buildArchive();
    archive.vocabularies[0].data = serializeVocabularyNative(VOCAB, { comments: [comment()] });
    const client = stubClient();
    const result = await runNativeImport({ client, projectId: 'newp', archive });
    const names = client.calls.map(([n]) => n);
    expect(names.indexOf('comments.create')).toBeLessThan(names.indexOf('documents.create'));
    expect(callsOf(client, 'comments.create')).toHaveLength(1);
    expect(result.warnings).toEqual([]);
  });
});

describe('runNativeImport — comments', () => {
  const comment = (over = {}) => ({
    id: 'c1',
    entityType: 'token',
    entityId: 'w1',
    author: { id: 'honestlyada@aol.com', name: 'Ada Lovelace' },
    body: 'Is this really a dative?',
    createdAt: '2026-08-14T09:31:07Z',
    updatedAt: '2026-08-14T09:31:07Z',
    ...over,
  });

  // Rebuild the archive with comments, going through the real serializer so
  // the anchors are the archive's own correlation keys.
  async function runWith(comments, overrides = {}) {
    const archive = buildArchive();
    const project = makeNativeProject();
    const igtDoc = new IgtDocument({ raw: makeNativeRaw(), project, vocabularies: {} });
    archive.documents[0].data = serializeDocumentNative(igtDoc, {
      mediaFile: 'media/Doc One.wav',
      comments,
    });
    const client = stubClient(overrides);
    const result = await runNativeImport({ client, projectId: 'newp', archive });
    return { client, result, posted: callsOf(client, 'comments.create') };
  }

  it('posts nothing when the archive carries no comments', async () => {
    const { posted } = await runWith([]);
    expect(posted).toEqual([]);
  });

  it('resolves each anchor type to the entity the import actually created', async () => {
    const { posted } = await runWith([
      comment({ id: 'c1', entityType: 'document', entityId: 'doc1' }),
      comment({ id: 'c2', entityType: 'text', entityId: 'text1' }),
      comment({ id: 'c3', entityType: 'token', entityId: 'w1' }),
      comment({ id: 'c4', entityType: 'span', entityId: 'sp1' }),
    ]);
    expect(posted.map((c) => c[1])).toEqual(['document', 'text', 'token', 'span']);
    // Every anchor is a NEW id minted during this import, never the archive's
    // own correlation key.
    for (const [, , entityId] of posted) {
      expect(entityId).toMatch(/^(doc|text|tok|span)-\d+$/);
    }
  });

  it('prefixes the body with the original attribution, since the server restamps the author', async () => {
    const { posted } = await runWith([comment()]);
    expect(posted).toHaveLength(1);
    expect(posted[0][3]).toBe(
      '> Imported from an archive. Originally posted by Ada Lovelace <honestlyada@aol.com> on 2026-08-14.\n\n' +
        'Is this really a dative?',
    );
  });

  it('warns and skips rather than guessing when an anchor did not survive', async () => {
    // The exporter drops a comment whose anchor is not in the file, so this
    // is an archive edited by hand.
    const archive = buildArchive();
    archive.documents[0].data.comments = [
      { id: 'c1', anchor: { type: 'token', id: 'nosuchtoken' }, body: 'x', author: {} },
    ];
    const client = stubClient();
    const result = await runNativeImport({ client, projectId: 'newp', archive });
    expect(callsOf(client, 'comments.create')).toEqual([]);
    expect(result.warnings).toContain(
      '"Doc One": comment c1 skipped (its token did not survive the import)',
    );
  });

  it('posts comments BEFORE the document is marked done, so a resume redoes them', async () => {
    const { client } = await runWith([comment()]);
    const names = client.calls.map(([n]) => n);
    expect(names.indexOf('comments.create')).toBeLessThan(names.indexOf('documents.setMetadata'));
  });
});

describe('runNativeImport (full archive)', () => {
  async function run(overrides = {}) {
    const archive = buildArchive();
    const client = stubClient(overrides);
    const result = await runNativeImport({ client, projectId: 'newp', archive });
    return { archive, client, result };
  }

  it('imports the document: text, tokens with reconstituted metadata, in layer order', async () => {
    const { client, result } = await run();
    expect(result).toMatchObject({ imported: 1, skipped: 0, redone: 0 });

    expect(callsOf(client, 'documents.create')[0].slice(1, 3)).toEqual(['newp', 'Doc One']);
    expect(callsOf(client, 'texts.create')[0][3]).toBe('perros corren. extra');

    const bulks = callsOf(client, 'tokens.bulkCreate').map((c) => c[1]);
    const byLayer = Object.fromEntries(bulks.map((specs) => [specs[0].tokenLayerId, specs]));

    // Words: orthographies reconstituted as orthog:* keys; orphan included.
    const words = byLayer['new-wl'];
    expect(words).toHaveLength(3);
    expect(words[0].metadata).toEqual({
      'orthog:Other': 'u',
      custom: 'x',
      'orthog:Translit': 'pt',
    });
    expect(words[1].metadata).toBeUndefined(); // w2 had no metadata
    expect(words[2].metadata).toEqual({ stray: true }); // the orphan word

    // Morphemes: form/morphType folded back, present-vs-absent preserved.
    const morphemes = byLayer['new-ml'];
    expect(morphemes).toHaveLength(4);
    expect(morphemes[0].metadata).toEqual({ form: 'perro', morphType: 'stem' });
    expect(morphemes[0].precedence).toBe(1);
    expect(morphemes[1].metadata).toEqual({ form: '' });
    expect(morphemes[2].metadata).toBeUndefined();
    expect(morphemes[3].metadata).toEqual({ form: 'or' }); // orphan morpheme

    // Alignment: times folded back into metadata.
    const alignment = byLayer['new-al'];
    expect(alignment[0].metadata).toEqual({ timeBegin: 1.25, timeEnd: 3.5, note: 'x' });

    // Sentences: tree sentence + none orphaned.
    expect(byLayer['new-sl']).toHaveLength(1);
    expect(byLayer['new-sl'][0].metadata).toEqual({ speaker: 'A' });
  });

  it('recreates spans deduped by span id, with provenance, plus extraSpans', async () => {
    const { client } = await run();
    const allSpans = callsOf(client, 'spans.bulkCreate').flatMap((c) => c[1]);
    // sp1 POS, sp2 Phrase (ONE span, two tokens), sp4 Translation, sp6 Gloss,
    // plus from extraSpans: sp5 (duplicate Translation) and sp3 (the unscoped
    // Mystery layer — it EXISTS in this stub's target project, so it resolves).
    expect(allSpans).toHaveLength(6);
    const phrase = allSpans.find((s) => s.value === 'NP');
    expect(phrase.tokens).toHaveLength(2);
    const pos = allSpans.find((s) => s.value === 'NOUN');
    expect(pos.metadata).toEqual({ prov: 'inferred', provConfirmed: true });
    expect(allSpans.filter((s) => ['The dogs run.', 'dup'].includes(s.value))).toHaveLength(2);
  });

  it('makes an unscoped span layer the project lacks, where its annotations point', async () => {
    const archive = buildArchive();
    const client = stubClient();
    const project = targetProject();
    const wordLayer = project.textLayers[0].tokenLayers[0];
    wordLayer.spanLayers = wordLayer.spanLayers.filter((sl) => sl.name !== 'Mystery');
    client.projects.get = async () => project;
    const result = await runNativeImport({ client, projectId: 'newp', archive });
    expect(result.warnings.filter((w) => /Mystery/.test(w))).toEqual([]);
    // Made once, on the word layer, since that is where its tokens are.
    expect(callsOf(client, 'spanLayers.create').map((c) => [c[1], c[2]])).toEqual([
      [wordLayer.id, 'Mystery'],
    ]);
    const allSpans = callsOf(client, 'spans.bulkCreate').flatMap((c) => c[1]);
    expect(allSpans).toHaveLength(6);
  });

  it('recreates vocab links (inline + extras) with mapped item and token ids', async () => {
    const { client, result } = await run();
    const links = callsOf(client, 'vocabLinks.bulkCreate').flatMap((c) => c[1]);
    // l1 inline on m1, l2 extra on m1, l3 extra multi-token on w1+w2.
    expect(links).toHaveLength(3);
    const multi = links.find((l) => l.tokens.length === 2);
    expect(multi.vocabItem).toMatch(/^item-/); // mapped item id
    expect(multi.tokens.every((t) => t.startsWith('tok-'))).toBe(true); // mapped tokens
    expect(multi.metadata).toEqual({ note: 'multi' });
    const inline = links.find((l) => l.metadata?.provSource === 'flex-import');
    expect(inline).toBeTruthy();
    expect(result.warnings).toEqual([]);
  });

  it('uploads media and marks the document done LAST', async () => {
    const { client } = await run();
    expect(callsOf(client, 'documents.uploadMedia')[0][2]).toBe('Doc One.wav');
    const last = client.calls.at(-1);
    expect(last[0]).toBe('documents.setMetadata');
    expect(last[2]).toMatchObject({ Source: 'notes', importDone: true });
  });

  it('writes autoAnalysis config from the schema', async () => {
    const { client } = await run();
    expect(callsOf(client, 'projects.setConfig')[0].slice(1)).toEqual([
      'newp',
      'igt',
      'autoAnalysis',
      { enabled: false },
    ]);
  });

  it('writes back the project config the setup wizard cannot rebuild', async () => {
    // The archive used to drop all of these, so a round trip returned a
    // project with no tagsets, no languages and no speakers.
    const archive = buildArchive();
    Object.assign(archive.manifest.schema, {
      tagsets: { Leipzig: { delimiters: '.', mode: 'closed', values: [{ value: 'PL' }] } },
      languages: { object: { name: 'Lamkang' }, meta: { name: 'English' } },
      speakers: ['Speaker 1'],
      serviceDefaults: { analyze: { impl: 'polygloss' } },
      exportPresets: { presets: [{ name: 'For the paper' }] },
      compose: { codes: [{ code: "b'", char: 'ɓ' }] },
    });
    const client = stubClient();
    await runNativeImport({ client, projectId: 'newp', archive });
    const written = Object.fromEntries(
      callsOf(client, 'projects.setConfig').map((c) => [c[3], c[4]]),
    );
    expect(written.tagsets).toEqual(archive.manifest.schema.tagsets);
    expect(written.languages).toEqual({ object: { name: 'Lamkang' }, meta: { name: 'English' } });
    expect(written.speakers).toEqual(['Speaker 1']);
    expect(written.serviceDefaults).toEqual({ analyze: { impl: 'polygloss' } });
    // Stored under its own key, which is `export`, not `exportPresets`.
    expect(written.export).toEqual({ presets: [{ name: 'For the paper' }] });
    expect(written.compose).toEqual({ codes: [{ code: "b'", char: 'ɓ' }] });
    // documentMetadata is rewritten so a metadata field's tagset comes back.
    expect(written.documentMetadata).toEqual([{ name: 'Source' }]);
  });

  it("brings back the project's annotation manual", async () => {
    const archive = buildArchive();
    archive.manifest.guidelines = [
      { title: 'Loanwords', body: 'Not segmented.', pinned: true },
      { title: 'Later', body: '', pinned: false },
    ];
    const client = stubClient();
    await runNativeImport({ client, projectId: 'newp', archive });
    expect(callsOf(client, 'guidelines.create').map((c) => c.slice(1))).toEqual([
      ['newp', 'Loanwords', { body: 'Not segmented.', pinned: true }],
      ['newp', 'Later', { body: '', pinned: false }],
    ]);
  });

  it('warns rather than losing the corpus when a guideline cannot be written', async () => {
    // An annotation manual is worth having and is not worth failing an import
    // of a thousand documents over.
    const archive = buildArchive();
    archive.manifest.guidelines = [{ title: 'Doomed', body: 'x', pinned: false }];
    const client = stubClient();
    client.guidelines.create = async () => {
      throw new Error('nope');
    };
    const result = await runNativeImport({ client, projectId: 'newp', archive });
    expect(result.warnings.some((w) => w.includes('Doomed'))).toBe(true);
  });

  it('writes no second copy of the manual when an import is resumed', async () => {
    // A resume runs the same engine over the same archive on the project the
    // first run left behind, where the guidelines it managed to write are.
    const archive = buildArchive();
    archive.manifest.guidelines = [
      { title: 'Loanwords', body: 'Not segmented.', pinned: true },
      { title: 'Loanwords', body: 'The older wording.', pinned: false },
      { title: 'Later', body: '', pinned: false },
    ];
    const client = stubClient();
    client.guidelines.list = async () => [
      { id: 'g1', title: 'Loanwords', body: 'Not segmented.', pinned: true },
    ];
    await runNativeImport({ client, projectId: 'newp', archive });
    // Title alone would have skipped the second Loanwords, which is its own
    // guideline: what is already there is matched on title AND body.
    expect(callsOf(client, 'guidelines.create').map((c) => c.slice(1))).toEqual([
      ['newp', 'Loanwords', { body: 'The older wording.', pinned: false }],
      ['newp', 'Later', { body: '', pinned: false }],
    ]);
  });

  it('is unbothered by an archive written before guidelines existed', async () => {
    const archive = buildArchive();
    delete archive.manifest.guidelines;
    const client = stubClient();
    await runNativeImport({ client, projectId: 'newp', archive });
    expect(callsOf(client, 'guidelines.create')).toEqual([]);
  });

  it("points each field back at its tagset, on the field's own span layer", async () => {
    const archive = buildArchive();
    archive.manifest.schema.fields.morpheme = [{ name: 'Gloss', tagset: 'Leipzig' }];
    const client = stubClient();
    await runNativeImport({ client, projectId: 'newp', archive });
    const calls = callsOf(client, 'spanLayers.setConfig').map((c) => c.slice(1));
    expect(calls).toEqual([['new-slGloss', 'igt', 'tagset', 'Leipzig']]);
  });

  it('writes no span-layer config when no field is governed', async () => {
    const { client } = await run();
    expect(callsOf(client, 'spanLayers.setConfig')).toEqual([]);
  });

  it('skips done documents and redoes half-imported ones on resume', async () => {
    const done = await run({
      existingDocs: [
        { id: 'old1', name: 'Doc One', metadata: { importSource: 'doc1', importDone: true } },
      ],
    });
    expect(done.result).toMatchObject({ imported: 0, skipped: 1, redone: 0 });

    const half = await run({
      existingDocs: [{ id: 'old1', name: 'Doc One', metadata: { importSource: 'doc1' } }],
    });
    expect(half.result).toMatchObject({ imported: 1, skipped: 0, redone: 1 });
    expect(callsOf(half.client, 'documents.delete')[0][1]).toBe('old1');
  });
});

describe('rebuildTokenMap', () => {
  it('maps a finished document by what its tokens are, not by creation order', async () => {
    // What a resume has to work from: the archive's document, and the server's
    // copy of it made by an earlier run, whose ids are its own.
    const docData = {
      id: 'old-doc',
      sentences: [
        {
          id: 's1',
          begin: 0,
          end: 10,
          words: [
            {
              id: 'w1',
              begin: 0,
              end: 4,
              morphemes: [
                { id: 'm1', begin: 0, end: 4, precedence: 1 },
                { id: 'm2', begin: 0, end: 4, precedence: 2 },
              ],
            },
            { id: 'w2', begin: 5, end: 10, morphemes: [] },
          ],
        },
      ],
    };
    const raw = {
      textLayers: [
        {
          tokenLayers: [
            {
              id: 'W',
              tokens: [
                { id: 'nw2', begin: 5, end: 10 },
                { id: 'nw1', begin: 0, end: 4 },
              ],
            },
            {
              id: 'M',
              tokens: [
                { id: 'nm2', begin: 0, end: 4, precedence: 2 },
                { id: 'nm1', begin: 0, end: 4, precedence: 1 },
              ],
            },
            { id: 'S', tokens: [{ id: 'ns1', begin: 0, end: 10 }] },
          ],
        },
      ],
    };
    const map = await rebuildTokenMap({
      client: { documents: { get: async () => raw } },
      docId: 'new-doc',
      docData,
      targets: { wordLayerId: 'W', morphemeLayerId: 'M', sentenceLayerId: 'S' },
    });
    // The sentence too: an entry's example may cite a whole sentence, and
    // without it a resume dropped that example as unresolvable.
    expect([...map]).toEqual([
      ['s1', 'ns1'],
      ['w1', 'nw1'],
      ['m1', 'nm1'],
      ['m2', 'nm2'],
      ['w2', 'nw2'],
    ]);
  });
});

describe('resolveNativeTargets', () => {
  it('throws when a schema field has no span layer', () => {
    const project = targetProject();
    const { manifest } = buildArchive();
    project.textLayers[0].tokenLayers[0].spanLayers = []; // drop word span layers
    expect(() => resolveNativeTargets(project, manifest)).toThrow(/POS.*missing/);
  });
});

// Where an entry ends up: the map the create wrote (the archive's copy plus this
// run's stamp), with the relink's PATCH applied — a null deleting its key. The
// relink used to send that end state as a whole-map PUT, so asserting it here is
// what says the patch lands in the same place.
const applied = (meta, archiveId, patch) => {
  const out = { ...meta, nativeImportId: archiveId };
  for (const [k, v] of Object.entries(patch || {})) {
    if (v === null) delete out[k];
    else out[k] = v;
  }
  return out;
};

describe('planVocabRelink — a dictionary survives the round trip', () => {
  const vocabData = {
    name: 'Lex',
    fields: [
      { name: 'gloss', inline: true },
      { name: 'variantOf', inline: false, type: 'item' },
      { name: 'seeAlso', inline: false, type: 'item', many: true },
    ],
    items: [
      { id: 'old-head', form: 'kat', metadata: { gloss: 'cat' } },
      {
        id: 'old-sense',
        form: 'kat',
        metadata: { gloss: 'lion', parent: 'old-head', senseOrder: 1 },
      },
      {
        id: 'old-run',
        form: 'run',
        metadata: {
          gloss: 'run',
          variantOf: 'old-head',
          seeAlso: ['old-sense', 'gone'],
          examples: [
            { document: 'old-doc', token: 'old-tok' },
            { document: 'old-doc', token: 'lost-tok' },
            { text: 'imported text', translation: 'stays' },
          ],
        },
      },
      { id: 'old-orphan', form: 'x', metadata: { parent: 'gone' } },
    ],
  };
  const itemIdMap = new Map([
    ['old-head', 'new-head'],
    ['old-sense', 'new-sense'],
    ['old-run', 'new-run'],
    ['old-orphan', 'new-orphan'],
  ]);
  const docMaps = new Map([
    ['old-doc', { docId: 'new-doc', tokenIdMap: new Map([['old-tok', 'new-tok']]) }],
  ]);

  it('maps parents, Entry fields and example references onto the new ids', () => {
    const { patches, dropped } = planVocabRelink(vocabData, itemIdMap, docMaps);
    const byId = Object.fromEntries(patches.map((p) => [p.id, p.metadata]));
    const meta = Object.fromEntries(vocabData.items.map((it) => [it.id, it.metadata]));
    // The patch names what the relink CHANGED and nothing else.
    expect(byId['new-sense']).toEqual({ parent: 'new-head' });
    expect(byId['new-run']).toEqual({
      variantOf: 'new-head',
      seeAlso: ['new-sense'],
      examples: [
        { document: 'new-doc', token: 'new-tok' },
        { text: 'imported text', translation: 'stays' },
      ],
    });
    // A parent that did not survive is NULLED, which is what deletes the key
    // and makes the item a headword. Absent, it would have stayed dangling.
    expect(byId['new-orphan']).toEqual({ parent: null });
    expect(byId['new-head']).toBeUndefined(); // nothing to relink
    expect(dropped).toEqual(['run: seeAlso', 'run: example', 'x: parent']);
    // And where each one ends up, which is where the whole-map write left it.
    expect(applied(meta['old-sense'], 'old-sense', byId['new-sense'])).toEqual({
      gloss: 'lion',
      parent: 'new-head',
      senseOrder: 1,
      nativeImportId: 'old-sense',
    });
    expect(applied(meta['old-run'], 'old-run', byId['new-run'])).toEqual({
      gloss: 'run',
      variantOf: 'new-head',
      seeAlso: ['new-sense'],
      examples: [
        { document: 'new-doc', token: 'new-tok' },
        { text: 'imported text', translation: 'stays' },
      ],
      nativeImportId: 'old-run',
    });
    expect(applied(meta['old-orphan'], 'old-orphan', byId['new-orphan'])).toEqual({
      nativeImportId: 'old-orphan',
    });
  });

  it('never writes back the stale stamp an older archive carries', () => {
    // An archive exported from a project that was itself imported carries
    // somebody else's stamp. The create already overwrote it with this run's,
    // so the relink must not put the stale one back — and a patch cannot,
    // because both sides of its diff carry this run's.
    const stale = {
      ...vocabData,
      items: [
        { id: 'old-head', form: 'lion', metadata: { gloss: 'lion' } },
        {
          id: 'old-sense',
          form: 'lion',
          metadata: { parent: 'old-head', senseOrder: 1, nativeImportId: 'from-an-older-archive' },
        },
      ],
    };
    const { patches } = planVocabRelink(stale, itemIdMap, docMaps);
    expect(patches).toEqual([{ id: 'new-sense', metadata: { parent: 'new-head' } }]);
    // Which leaves the item stamped by this run, so a resume knows it again.
    expect(applied(stale.items[1].metadata, 'old-sense', patches[0].metadata).nativeImportId).toBe(
      'old-sense',
    );
  });

  it('keeps an example pointing into a document an earlier run finished', async () => {
    // The resume skips a document that is already done, so the last pass has
    // no token map for it and used to drop every example pointing into it.
    const archive = buildArchive();
    const [first] = archive.vocabularies[0].data.items;
    const word = archive.documents[0].data.sentences[0].words[0];
    first.metadata = {
      ...(first.metadata || {}),
      examples: [{ document: archive.documents[0].data.id, token: word.id }],
    };
    const client = stubClient({
      existingDocs: [
        {
          id: 'srv-doc',
          name: 'Doc One',
          metadata: { importSource: 'doc1', importDone: true },
          // The server's copy of it, with ids of its own.
          textLayers: [
            {
              tokenLayers: [
                { id: 'new-wl', tokens: [{ id: 'srv-w1', begin: word.begin, end: word.end }] },
              ],
            },
          ],
        },
      ],
    });
    const result = await runNativeImport({ client, projectId: 'newp', archive });
    expect(result.skipped).toBe(1);
    const write = itemPatches(client).find((e) => e.metadata?.examples);
    expect(write.metadata.examples).toEqual([{ document: 'srv-doc', token: 'srv-w1' }]);
    expect(result.warnings.filter((w) => /reference/.test(w))).toHaveLength(0);
  });

  it('runs last in a full import and writes through the client', async () => {
    const archive = buildArchive();
    archive.vocabularies[0].data.fields.push({ name: 'variantOf', inline: false, type: 'item' });
    const [first, second] = archive.vocabularies[0].data.items;
    second.metadata = { ...(second.metadata || {}), parent: first.id, senseOrder: 1 };
    const client = stubClient();
    const result = await runNativeImport({ client, projectId: 'newp', archive });
    const writes = itemPatches(client);
    expect(writes).toHaveLength(1);
    const meta = writes[0].metadata;
    expect(meta.parent).toMatch(/^item-/);
    // senseOrder is NOT in the patch, and must not be: the item was created
    // from the archive already carrying it, so it is not what changed. Only
    // `parent` was an archive id needing the real one.
    expect(meta).not.toHaveProperty('senseOrder');
    const names = client.calls.map((c) => c[0]);
    expect(names.lastIndexOf('vocabItems.bulkUpdate')).toBeGreaterThan(
      names.lastIndexOf('documents.setMetadata'),
    );
    expect(result.warnings.filter((w) => /reference/.test(w))).toHaveLength(0);
  });
});

describe("runNativeImport, other apps' layers", () => {
  // An archive of the loss-trap document with a made-up app's layers beside
  // this app's (testFixtures.js makeOtherAppRaw), through the real exporter.
  function otherAppArchive({ comments = [] } = {}) {
    const archive = buildArchive();
    const project = makeOtherAppProject();
    const igtDoc = new IgtDocument({ raw: makeOtherAppRaw(), project, vocabularies: {} });
    archive.manifest = buildProjectFile({
      project,
      documents: archive.manifest.documents,
      vocabularies: archive.manifest.vocabularies,
      exportedAt: '2026-09-19T00:00:00.000Z',
    });
    archive.documents[0].data = serializeDocumentNative(igtDoc, {
      mediaFile: 'media/Doc One.wav',
      comments,
    });
    return archive;
  }
  const madeBy = (client, name, pick) => callsOf(client, name).find(pick)?.result?.id;
  // The ids a bulk create answered, by the archive ids of what it was given.
  const bulkIds = (client, name, pick) => {
    const call = callsOf(client, name).find(([, specs]) => pick(specs));
    return call?.result?.ids ?? [];
  };

  async function freshImport(archive = otherAppArchive()) {
    const client = stubClient();
    const result = await runNativeImport({ client, projectId: 'newp', archive });
    return { client, result };
  }

  it('writes the project settings back, but never this app’s or the review list', async () => {
    const { client, result } = await freshImport();
    expect(result.warnings).toEqual([]);
    const other = argsOf(client, 'projects.setConfig').filter(([, ns]) => ns !== 'igt');
    expect(other).toEqual([
      ['newp', 'other', 'setting', 'x'],
      ['newp', 'other', 'nested', { a: [1, 2] }],
    ]);
    expect(argsOf(client, 'textLayers.setConfig')).toEqual([['new-tl1', 'other', 'locale', 'es']]);
  });

  it('makes each token layer once, parents first, and writes its settings key by key', async () => {
    const { client } = await freshImport();
    const created = argsOf(client, 'tokenLayers.create');
    expect(created.map((c) => c.slice(0, 3))).toEqual([
      ['new-tl1', 'Nodes', 'any'],
      ['new-tl1', 'Words', 'non-overlapping'],
      ['new-tl1', 'Parts', 'any'],
    ]);
    const wordsId = madeBy(client, 'tokenLayers.create', (c) => c[2] === 'Words');
    expect(created.map((c) => c[3])).toEqual([undefined, 'new-wl', wordsId]);
    expect(argsOf(client, 'tokenLayers.setConfig').map((c) => c.slice(1))).toEqual([
      ['other', 'nodes', true],
      ['plaid', 'role', 'other-word'],
      ['other', 'words', true],
      ['other', 'parts', true],
    ]);
    const nodesId = madeBy(client, 'tokenLayers.create', (c) => c[2] === 'Nodes');
    const lemmaId = madeBy(client, 'spanLayers.create', (c) => c[2] === 'Lemma');
    const conceptsId = madeBy(client, 'spanLayers.create', (c) => c[2] === 'Concepts');
    // The span layer no field is goes back on this app's word layer, where it was.
    expect(argsOf(client, 'spanLayers.create')).toEqual([
      ['new-wl', 'Lemma'],
      [nodesId, 'Concepts'],
    ]);
    expect(argsOf(client, 'relationLayers.create')).toEqual([
      [lemmaId, 'Deps'],
      [conceptsId, 'Relations'],
    ]);
    expect(argsOf(client, 'spanLayers.setConfig')).toEqual([
      [lemmaId, 'other', 'lemma', true],
      [conceptsId, 'other', 'concepts', true],
    ]);
    expect(argsOf(client, 'relationLayers.setConfig').map((c) => c.slice(1))).toEqual([
      ['other', 'deps', true],
      ['other', 'relations', true],
    ]);
  });

  it('puts each token back on its layer, a zero-width one included', async () => {
    const { client } = await freshImport();
    const nodesId = madeBy(client, 'tokenLayers.create', (c) => c[2] === 'Nodes');
    const nodes = argsOf(client, 'tokens.bulkCreate')
      .map(([specs]) => specs)
      .find((specs) => specs[0].tokenLayerId === nodesId);
    expect(nodes).toEqual([
      {
        tokenLayerId: nodesId,
        text: expect.any(String),
        begin: 20,
        end: 20,
        metadata: { abstract: 'person' },
      },
      { tokenLayerId: nodesId, text: expect.any(String), begin: 0, end: 6, precedence: 2 },
    ]);
    // After this app's own tokens, so a layer nested in the word layer has
    // words to sit in.
    const layersInOrder = argsOf(client, 'tokens.bulkCreate').map(
      ([specs]) => specs[0].tokenLayerId,
    );
    expect(layersInOrder.indexOf(nodesId)).toBeGreaterThan(layersInOrder.indexOf('new-wl'));
  });

  it('maps span tokens and relation ends onto what the import made', async () => {
    const { client } = await freshImport();
    const conceptsId = madeBy(client, 'spanLayers.create', (c) => c[2] === 'Concepts');
    const lemmaId = madeBy(client, 'spanLayers.create', (c) => c[2] === 'Lemma');
    const [n1, n2] = bulkIds(client, 'tokens.bulkCreate', (specs) => specs[0].begin === 20);
    const concepts = argsOf(client, 'spans.bulkCreate')
      .map(([specs]) => specs)
      .find((specs) => specs[0].spanLayerId === conceptsId);
    expect(concepts).toEqual([
      { spanLayerId: conceptsId, tokens: [n1], value: 'person' },
      { spanLayerId: conceptsId, tokens: [n2], value: 'dog', metadata: { note: 'x' } },
    ]);
    const [c1, c2] = bulkIds(
      client,
      'spans.bulkCreate',
      (specs) => specs[0].spanLayerId === conceptsId,
    );
    // The Lemma annotations are this app's extraSpans, made on the layer the
    // archive described rather than on a second one of that name.
    const [lem1, lem2] = bulkIds(
      client,
      'spans.bulkCreate',
      (specs) => specs[0].spanLayerId === lemmaId,
    );
    const relations = argsOf(client, 'relations.bulkCreate').map(([specs]) => specs);
    const relsId = madeBy(client, 'relationLayers.create', (c) => c[2] === 'Relations');
    const depsId = madeBy(client, 'relationLayers.create', (c) => c[2] === 'Deps');
    expect(relations).toEqual(
      expect.arrayContaining([
        [{ relationLayerId: depsId, source: lem2, target: lem1, value: 'nsubj' }],
        [
          {
            relationLayerId: relsId,
            source: c1,
            target: c2,
            value: ':ARG0',
            metadata: { prov: 'inferred' },
          },
        ],
      ]),
    );
    expect(relations).toHaveLength(2);
    // Before the lexicon links, which may be on another app's tokens.
    const names = client.calls.map(([n]) => n);
    expect(names.lastIndexOf('relations.bulkCreate')).toBeLessThan(
      names.indexOf('vocabLinks.bulkCreate'),
    );
  });

  it('hangs comments on the tokens, annotations and relations it made', async () => {
    const comment = (id, entityType, entityId) => ({
      id,
      entityType,
      entityId,
      author: { id: 'ada@x.com', name: 'Ada' },
      body: 'Hm.',
      createdAt: '2026-08-14T09:31:07Z',
      updatedAt: '2026-08-14T09:31:07Z',
    });
    const archive = otherAppArchive({
      comments: [
        comment('k1', 'token', 'n1'),
        comment('k2', 'span', 'c2'),
        comment('k3', 'relation', 'r1'),
      ],
    });
    const { client, result } = await freshImport(archive);
    expect(result.warnings).toEqual([]);
    const [n1] = bulkIds(client, 'tokens.bulkCreate', (specs) => specs[0].begin === 20);
    const [relation] = bulkIds(
      client,
      'relations.bulkCreate',
      (specs) => specs[0].value === ':ARG0',
    );
    const posted = argsOf(client, 'comments.create');
    expect(posted.map((c) => c[0])).toEqual(['token', 'span', 'relation']);
    expect(posted[0][1]).toBe(n1);
    expect(posted[1][1]).toMatch(/^span-/);
    expect(posted[2][1]).toBe(relation);
  });

  it('makes no layer twice when a resumed import finds what an earlier run made', async () => {
    // The project an interrupted run left: every layer made, and one setting
    // not yet written. A project read carries no overlap mode or parent, so
    // the importer asks for those.
    const project = targetProject();
    const text = project.textLayers[0];
    text.config = { ...text.config, other: { locale: 'es' } };
    const wordLayer = text.tokenLayers.find((tl) => tl.id === 'new-wl');
    wordLayer.spanLayers.push({
      id: 'had-lemma',
      name: 'Lemma',
      config: { other: { lemma: true } },
      relationLayers: [{ id: 'had-deps', name: 'Deps', config: { other: { deps: true } } }],
    });
    text.tokenLayers.push(
      {
        id: 'had-nodes',
        name: 'Nodes',
        config: { other: { nodes: true } },
        spanLayers: [
          {
            id: 'had-concepts',
            name: 'Concepts',
            config: { other: { concepts: true } },
            relationLayers: [
              { id: 'had-rels', name: 'Relations', config: { other: { relations: true } } },
            ],
          },
        ],
      },
      {
        id: 'had-words',
        name: 'Words',
        config: { plaid: { role: 'other-word' }, other: { words: true } },
        spanLayers: [],
      },
      { id: 'had-parts', name: 'Parts', config: {}, spanLayers: [] },
    );
    const client = stubClient({
      tokenLayerShapes: {
        'had-nodes': { overlapMode: 'any', parentTokenLayer: null },
        'had-words': { overlapMode: 'non-overlapping', parentTokenLayer: 'new-wl' },
        'had-parts': { overlapMode: 'any', parentTokenLayer: 'had-words' },
      },
    });
    client.projects.get = async () => project;
    const result = await runNativeImport({ client, projectId: 'newp', archive: otherAppArchive() });
    expect(result.warnings).toEqual([]);
    expect(callsOf(client, 'tokenLayers.create')).toEqual([]);
    expect(callsOf(client, 'spanLayers.create')).toEqual([]);
    expect(callsOf(client, 'relationLayers.create')).toEqual([]);
    expect(callsOf(client, 'textLayers.setConfig')).toEqual([]);
    // Only the setting the earlier run did not get to.
    expect(argsOf(client, 'tokenLayers.setConfig')).toEqual([
      ['had-parts', 'other', 'parts', true],
    ]);
    // And the document's data goes onto the layers that were already there.
    const layers = argsOf(client, 'tokens.bulkCreate').map(([specs]) => specs[0].tokenLayerId);
    expect(layers).toEqual(expect.arrayContaining(['had-nodes', 'had-words', 'had-parts']));
    const relationLayers = argsOf(client, 'relations.bulkCreate').map(
      ([specs]) => specs[0].relationLayerId,
    );
    expect(relationLayers.sort()).toEqual(['had-deps', 'had-rels']);
  });

  it('warns rather than making a span layer the archive does not describe', async () => {
    // The older path made one here from the name alone, cached per run: a
    // resumed import made the layer a second time. Every layer a current
    // archive holds is described, so the fallback only ever ran for one
    // edited by hand.
    const archive = otherAppArchive();
    archive.manifest.otherLayers.spanLayers = archive.manifest.otherLayers.spanLayers.filter(
      (sl) => sl.name !== 'Lemma',
    );
    const { client, result } = await freshImport(archive);
    expect(argsOf(client, 'spanLayers.create').map((c) => c[1])).toEqual(['Concepts']);
    // Said once for the layer, not once per annotation on it.
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        'Annotation layer "Lemma" skipped (the archive does not describe it)',
      ]),
    );
    expect(
      result.warnings.filter((w) => w.includes('"Lemma" skipped (the archive does not describe')),
    ).toHaveLength(1);
  });

  it('warns rather than guessing when the layer another is nested in did not come back', async () => {
    const archive = otherAppArchive();
    const words = archive.manifest.otherLayers.tokenLayers.find((tl) => tl.name === 'Words');
    words.parent = { role: 'no-such-role' };
    const { client, result } = await freshImport(archive);
    expect(argsOf(client, 'tokenLayers.create').map((c) => c[1])).toEqual(['Nodes']);
    expect(result.warnings).toEqual([
      'Annotation layer "Words" skipped (the layer it is nested in is missing)',
      'Annotation layer "Parts" skipped (the layer it is nested in is missing)',
      '"Doc One": 1 token from another app skipped (their layer is missing)',
      '"Doc One": 1 token from another app skipped (their layer is missing)',
    ]);
  });
});

describe('importOtherLayerData', () => {
  const tokens = (n) =>
    Array.from({ length: n }, (_, i) => ({ id: `t${i}`, begin: i, end: i + 1 }));

  it('sends a partitioning layer whole and chunks every other kind', async () => {
    const restored = noOtherLayers();
    restored.order.push('part', 'free');
    restored.tokenLayers.set('part', { id: 'new-part', overlapMode: 'partitioning' });
    restored.tokenLayers.set('free', { id: 'new-free', overlapMode: 'any' });
    const client = stubClient();
    const tokenIdMap = new Map();
    await importOtherLayerData({
      client,
      docData: {
        name: 'Doc',
        // Listed child first: the layers go in the order they were made in.
        otherLayers: {
          tokens: [
            { layer: 'free', tokens: tokens(CHUNK + 1) },
            { layer: 'part', tokens: tokens(CHUNK + 1) },
          ],
        },
      },
      textId: 'text',
      restored,
      tokenIdMap,
      spanIdMap: new Map(),
      relationIdMap: new Map(),
    });
    const sizes = argsOf(client, 'tokens.bulkCreate').map(([specs]) => [
      specs[0].tokenLayerId,
      specs.length,
    ]);
    expect(sizes).toEqual([
      ['new-part', CHUNK + 1],
      ['new-free', CHUNK],
      ['new-free', 1],
    ]);
    // Both layers used the same archive ids here, and each maps to what its
    // own create answered, the later layer winning.
    expect(tokenIdMap.size).toBe(CHUNK + 1);
  });

  it('skips and counts what it cannot place', async () => {
    const restored = noOtherLayers();
    restored.spanLayers.set('sl', 'new-sl');
    restored.relationLayers.set('rl', 'new-rl');
    const client = stubClient();
    const warnings = [];
    await importOtherLayerData({
      client,
      docData: {
        name: 'Doc',
        otherLayers: {
          tokens: [{ layer: 'gone', tokens: [{ id: 'x', begin: 0, end: 1 }] }],
          spans: [{ layer: 'sl', spans: [{ id: 's1', tokens: ['nosuch'], value: 'v' }] }],
          relations: [
            { layer: 'rl', relations: [{ id: 'r1', source: 's1', target: 's1', value: 'v' }] },
          ],
        },
      },
      textId: 'text',
      restored,
      tokenIdMap: new Map(),
      spanIdMap: new Map(),
      relationIdMap: new Map(),
      warnings,
    });
    expect(warnings).toEqual([
      '"Doc": 1 token from another app skipped (their layer is missing)',
      '"Doc": 1 annotation from another app skipped (unresolvable tokens)',
      '"Doc": 1 relation skipped (unresolvable annotations)',
    ]);
    expect(callsOf(client, 'tokens.bulkCreate')).toEqual([]);
    expect(callsOf(client, 'spans.bulkCreate')).toEqual([]);
    expect(callsOf(client, 'relations.bulkCreate')).toEqual([]);
  });
});

describe('runNativeImport, references in metadata', () => {
  // The loss-trap document: sentence s1, words w1 w2 (w3 an orphan), morphemes
  // m1 m2 m3, annotations sp1 to sp6. A value naming one of them by its
  // archive id has to name what the import made of it.
  // The id a bulk create answered for the first spec `pick` accepts.
  const madeFor = (client, name, pick) => {
    const call = callsOf(client, name).find(([, specs]) => specs.some(pick));
    return call?.result?.ids?.[call[1].findIndex(pick)];
  };
  const sentenceId = (client) =>
    madeFor(client, 'tokens.bulkCreate', (spec) => spec.tokenLayerId === 'new-sl');
  const spanId = (client, value) => madeFor(client, 'spans.bulkCreate', (sp) => sp.value === value);
  const wordIds = (client) =>
    callsOf(client, 'tokens.bulkCreate').find(([, specs]) => specs[0].tokenLayerId === 'new-wl')
      .result.ids;
  const morphemeIds = (client) =>
    callsOf(client, 'tokens.bulkCreate').find(([, specs]) => specs[0].tokenLayerId === 'new-ml')
      .result.ids;

  async function importWith(edit, overrides = {}) {
    const archive = buildArchive();
    edit(archive);
    const client = stubClient(overrides);
    const result = await runNativeImport({ client, projectId: 'newp', archive });
    return { client, result, archive };
  }

  it('patches nothing when nothing names anything', async () => {
    const { client } = await importWith(() => {});
    for (const name of [
      'tokens.bulkUpdate',
      'spans.bulkUpdate',
      'relations.bulkUpdate',
      'texts.patchMetadata',
      'documents.patchMetadata',
    ]) {
      expect(callsOf(client, name)).toEqual([]);
    }
  });

  it('writes a reference to what already exists as the new id, straight away', async () => {
    // An annotation naming the sentence it belongs to: sentences are made first.
    const { client } = await importWith((archive) => {
      const pos = archive.documents[0].data.sentences[0].words[0].fields.POS;
      pos.metadata = { ...pos.metadata, other: { sentence: 's1', path: [['s1']] } };
    });
    const pos = callsOf(client, 'spans.bulkCreate')
      .flatMap(([, specs]) => specs)
      .find((sp) => sp.value === 'NOUN');
    const s1 = sentenceId(client);
    expect(s1).toMatch(/^tok-/);
    expect(pos.metadata).toEqual({
      prov: 'inferred',
      provConfirmed: true,
      other: { sentence: s1, path: [[s1]] },
    });
    expect(callsOf(client, 'spans.bulkUpdate')).toEqual([]);
  });

  it('patches a reference to what is made later, before the document is done', async () => {
    // A sentence naming one of its annotations, made after every token.
    const { client } = await importWith((archive) => {
      archive.documents[0].data.sentences[0].metadata = { speaker: 'A', gloss: 'sp4' };
    });
    const [sentence] = callsOf(client, 'tokens.bulkCreate').find(
      ([, specs]) => specs[0].tokenLayerId === 'new-sl',
    )[1];
    expect(sentence.metadata).toEqual({ speaker: 'A', gloss: 'sp4' });
    expect(argsOf(client, 'tokens.bulkUpdate')).toEqual([
      [[{ id: sentenceId(client), metadata: { gloss: spanId(client, 'The dogs run.') } }]],
    ]);
    const names = client.calls.map(([n]) => n);
    expect(names.indexOf('tokens.bulkUpdate')).toBeLessThan(
      names.lastIndexOf('documents.setMetadata'),
    );
  });

  it('follows a reference into arrays and objects, and leaves keys and parts of strings alone', async () => {
    const { client } = await importWith((archive) => {
      const [, w2] = archive.documents[0].data.sentences[0].words;
      w2.metadata = { refs: [{ at: 'w1' }, 'm1', 3], note: 'see w1', w1: 'kept', flag: true };
    });
    const [w1] = wordIds(client);
    const [m1] = morphemeIds(client);
    // w1 is made in the same request and m1 after it, so both are patched,
    // and the patch holds the one key that changed.
    expect(argsOf(client, 'tokens.bulkUpdate')).toEqual([
      [[{ id: wordIds(client)[1], metadata: { refs: [{ at: w1 }, m1, 3] } }]],
    ]);
  });

  it("resolves another app's references through the same maps", async () => {
    // An annotation of another app naming a sentence of this one, and a
    // relation naming the token it starts from.
    const { client, result } = await importWith((archive) => {
      const data = archive.documents[0].data;
      data.otherLayers = {
        tokens: [{ layer: 'olNodes', tokens: [{ id: 'n1', begin: 20, end: 20 }] }],
        spans: [
          {
            layer: 'olConcepts',
            spans: [{ id: 'c1', tokens: ['n1'], value: 'x', metadata: { sentence: 's1' } }],
          },
        ],
        relations: [
          {
            layer: 'olRels',
            relations: [
              { id: 'r1', source: 'c1', target: 'c1', value: 'y', metadata: { from: 'n1' } },
            ],
          },
        ],
      };
      archive.manifest.otherLayers.tokenLayers = [
        {
          id: 'olNodes',
          name: 'Nodes',
          overlapMode: 'any',
          parent: null,
          config: {},
          spanLayers: [
            {
              id: 'olConcepts',
              name: 'Concepts',
              config: {},
              relationLayers: [{ id: 'olRels', name: 'Relations', config: {} }],
            },
          ],
        },
      ];
    });
    expect(result.warnings).toEqual([]);
    const concept = callsOf(client, 'spans.bulkCreate')
      .flatMap(([, specs]) => specs)
      .find((sp) => sp.value === 'x');
    expect(concept.metadata).toEqual({ sentence: sentenceId(client) });
    const node = madeFor(client, 'tokens.bulkCreate', (spec) => spec.begin === 20);
    const [relation] = callsOf(client, 'relations.bulkCreate')[0][1];
    expect(relation.metadata).toEqual({ from: node });
  });

  // Two documents, the second a copy of the first under ids of its own.
  function twoDocuments(archive, { first = {}, second = {} } = {}) {
    const data = JSON.parse(JSON.stringify(archive.documents[0].data));
    data.id = 'doc2';
    data.name = 'Doc Two';
    archive.documents.push({ ...archive.documents[0], id: 'doc2', name: 'Doc Two', data });
    Object.assign(archive.documents[0].data.metadata, first);
    Object.assign(data.metadata, second);
  }

  it('patches a document naming a later one once that one is in, never its own stamp', async () => {
    const { client, result } = await importWith((archive) =>
      twoDocuments(archive, {
        first: { next: 'doc2', self: 'doc1' },
        second: { previous: 'doc1' },
      }),
    );
    expect(result.imported).toBe(2);
    const [one, two] = callsOf(client, 'documents.create').map((c) => c.result.id);
    const created = callsOf(client, 'documents.create').map(([, , , metadata]) => metadata);
    // The first is made before the second exists, and before its own id is known.
    expect(created[0]).toMatchObject({ next: 'doc2', self: 'doc1' });
    // The second names the first, which is done by then.
    expect(created[1]).toMatchObject({ previous: one, importSource: 'doc2' });
    // Its own id is known by the time it is marked done.
    const done = argsOf(client, 'documents.setMetadata').find(([id]) => id === one)[1];
    expect(done).toMatchObject({ self: one, next: 'doc2', importSource: 'doc1' });
    expect(argsOf(client, 'documents.patchMetadata')).toEqual([[one, { next: two }]]);
  });

  it('settles a document an earlier run finished, which still names a later one', async () => {
    const { client } = await importWith(
      (archive) => twoDocuments(archive, { first: { next: 'doc2' }, second: { previous: 'doc1' } }),
      {
        existingDocs: [
          {
            id: 'old1',
            name: 'Doc One',
            metadata: { importSource: 'doc1', importDone: true, Source: 'notes', next: 'doc2' },
          },
        ],
      },
    );
    const [two] = callsOf(client, 'documents.create').map((c) => c.result.id);
    const [, , , created] = callsOf(client, 'documents.create')[0];
    expect(created.previous).toBe('old1');
    // The stamp is the archive's id for the document itself, on purpose.
    expect(argsOf(client, 'documents.patchMetadata')).toEqual([['old1', { next: two }]]);
  });

  it('patches what is in a document naming a later document, from what the server holds', async () => {
    const archive = buildArchive();
    twoDocuments(archive);
    archive.documents[0].data.sentences[0].fields.Translation.metadata = { see: 'doc2' };
    const client = stubClient();
    const plain = client.documents.get;
    // The server's copy of the first document, holding the reference as written.
    client.documents.get = async (id, full) =>
      full
        ? {
            textLayers: [
              {
                text: { id: 'srv-text', metadata: {} },
                tokenLayers: [
                  {
                    tokens: [{ id: 'srv-tok', metadata: { k: 1 } }],
                    spanLayers: [
                      { spans: [{ id: 'srv-span', metadata: { see: 'doc2', note: 'doc2 x' } }] },
                    ],
                  },
                ],
              },
            ],
          }
        : plain(id);
    await runNativeImport({ client, projectId: 'newp', archive });
    const [, two] = callsOf(client, 'documents.create').map((c) => c.result.id);
    expect(argsOf(client, 'spans.bulkUpdate')).toEqual([
      [[{ id: 'srv-span', metadata: { see: two } }]],
    ]);
    expect(callsOf(client, 'tokens.bulkUpdate')).toEqual([]);
    expect(callsOf(client, 'texts.patchMetadata')).toEqual([]);
  });
});

describe('planVocabRelink, references in metadata', () => {
  it('maps any value naming an entry or a document, but never its own stamp', () => {
    const vocabData = {
      name: 'Lex',
      fields: [{ name: 'gloss', inline: true }],
      items: [
        { id: 'old-a', form: 'a', metadata: {} },
        {
          id: 'old-b',
          form: 'b',
          metadata: {
            cognate: 'old-a',
            source: { document: 'old-doc' },
            note: 'old-a is related',
            nativeImportId: 'old-a',
          },
        },
      ],
    };
    const itemIdMap = new Map([
      ['old-a', 'new-a'],
      ['old-b', 'new-b'],
    ]);
    const { patches } = planVocabRelink(
      vocabData,
      itemIdMap,
      new Map(),
      new Map([['old-doc', 'new-doc']]),
    );
    // The stamp is not rewritten, and not even named: the create wrote it.
    // `note` merely CONTAINS an archive id, so it is not a reference and is
    // absent from the patch too.
    expect(patches).toEqual([
      { id: 'new-b', metadata: { cognate: 'new-a', source: { document: 'new-doc' } } },
    ]);
    expect(applied(vocabData.items[1].metadata, 'old-b', patches[0].metadata)).toEqual({
      cognate: 'new-a',
      source: { document: 'new-doc' },
      note: 'old-a is related',
      nativeImportId: 'old-b',
    });
  });
});
