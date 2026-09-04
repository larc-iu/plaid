import { describe, it, expect } from 'vitest';
import { IgtDocument } from '../../domain/IgtDocument.js';
import {
  buildProjectFile,
  serializeVocabularyNative,
  serializeDocumentNative,
} from '../../export/nativeJson.js';
import { makeNativeRaw, makeNativeProject } from '../../export/testFixtures.js';
import {
  deriveSetupData,
  resolveNativeTargets,
  importVocabulary,
  runNativeImport,
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

function stubClient({ existingDocs = [], existingItems = [] } = {}) {
  const calls = [];
  let batch = null;
  let nextId = 0;
  const fresh = (prefix) => `${prefix}-${nextId++}`;
  const record = (name, args, result) => {
    calls.push([name, ...args]);
    return result;
  };
  return {
    calls,
    projects: {
      get: async (id) => record('projects.get', [id], targetProject()),
      setConfig: async (...a) => record('projects.setConfig', a),
      listDocuments: async (id) => record('projects.listDocuments', [id], existingDocs),
    },
    vocabLayers: {
      get: async (id) => record('vocabLayers.get', [id], { id, items: existingItems }),
      setConfig: async (...a) => record('vocabLayers.setConfig', a),
    },
    spanLayers: {
      setConfig: async (...a) => record('spanLayers.setConfig', a),
    },
    vocabItems: {
      bulkCreate: async (body) =>
        record('vocabItems.bulkCreate', [body], { ids: body.map(() => fresh('item')) }),
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
    beginBatch: () => {
      batch = [];
    },
    submitBatch: async () => {
      const out = batch;
      batch = null;
      return out;
    },
    withOperation: async (_message, fn) => fn(() => {}),
    batched: async (fn) => {
      batch = [];
      await fn();
      const out = batch;
      batch = null;
      return out;
    },
    documents: {
      create: async (projectId, name, metadata) =>
        record('documents.create', [projectId, name, metadata], { id: fresh('doc') }),
      get: async (id) =>
        record(
          'documents.get',
          [id],
          existingDocs.find((d) => d.id === id) ?? { id, metadata: {} },
        ),
      delete: async (id) => record('documents.delete', [id]),
      setMetadata: async (...a) => record('documents.setMetadata', a),
      uploadMedia: async (id, file) => record('documents.uploadMedia', [id, file?.name]),
    },
    texts: {
      create: async (...a) => record('texts.create', a, { id: fresh('text') }),
    },
    tokens: {
      bulkCreate: async (specs) =>
        record('tokens.bulkCreate', [specs], { ids: specs.map(() => fresh('tok')) }),
    },
    spans: {
      bulkCreate: async (specs) =>
        record('spans.bulkCreate', [specs], { ids: specs.map(() => fresh('span')) }),
    },
    comments: {
      create: (entityType, entityId, body) => {
        const result = { id: fresh('comment') };
        record('comments.create', [entityType, entityId, body], result);
        if (batch) batch.push(result);
        return result;
      },
    },
  };
}

const callsOf = (client, name) => client.calls.filter(([n]) => n === name);

// A vocab bulkCreate carries many entries in one call; flatten them back to
// per-item records so the assertions below stay item-shaped.
const createdItems = (client) =>
  callsOf(client, 'vocabItems.bulkCreate').flatMap(([, body]) => body);

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
        { name: 'Translation', scope: 'Sentence', isCustom: true },
        { name: 'POS', scope: 'Word', isCustom: true },
        { name: 'Phrase', scope: 'Word', isCustom: true },
        { name: 'Gloss', scope: 'Morpheme', isCustom: true },
      ]),
    );
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
    const { result, posted } = await runWith([comment({ entityId: 'nosuchtoken' })]);
    expect(posted).toEqual([]);
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

  it('skips extra spans whose layer the target project lacks, with a warning', async () => {
    const archive = buildArchive();
    const client = stubClient();
    const project = targetProject();
    const wordLayer = project.textLayers[0].tokenLayers[0];
    wordLayer.spanLayers = wordLayer.spanLayers.filter((sl) => sl.name !== 'Mystery');
    client.projects.get = async () => project;
    const result = await runNativeImport({ client, projectId: 'newp', archive });
    expect(result.warnings.filter((w) => /Mystery/.test(w))).toHaveLength(1);
    const allSpans = callsOf(client, 'spans.bulkCreate').flatMap((c) => c[1]);
    expect(allSpans).toHaveLength(5);
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
    expect(last[2]).toMatchObject({ Source: 'notes', nativeImported: true });
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
      existingDocs: [{ id: 'old1', name: 'Doc One', metadata: { nativeImported: true } }],
    });
    expect(done.result).toMatchObject({ imported: 0, skipped: 1, redone: 0 });

    const half = await run({
      existingDocs: [{ id: 'old1', name: 'Doc One', metadata: {} }],
    });
    expect(half.result).toMatchObject({ imported: 1, skipped: 0, redone: 1 });
    expect(callsOf(half.client, 'documents.delete')[0][1]).toBe('old1');
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
