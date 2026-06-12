import { describe, it, expect } from 'vitest';
import { IgtDocument } from '../../domain/IgtDocument.js';
import {
  buildProjectFile, serializeVocabularyNative, serializeDocumentNative,
} from '../../export/nativeJson.js';
import { makeNativeRaw, makeNativeProject } from '../../export/testFixtures.js';
import {
  deriveSetupData, resolveNativeTargets, importVocabulary, runNativeImport,
} from './importEngine.js';

// ---- the archive under test: built by the REAL exporter --------------------
// Export the loss-trap fixture document, then import the result — the test is
// the exporter↔importer contract itself.

const VOCAB = {
  id: 'vocab1', name: 'Lex',
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
      documents: [{ id: 'doc1', name: 'Doc One', file: 'documents/Doc One.json', mediaFile: 'media/Doc One.wav' }],
      vocabularies: [{ id: 'vocab1', name: 'Lex', file: 'vocabularies/Lex.json' }],
      exportedAt: '2026-06-12T00:00:00.000Z',
    }),
    vocabularies: [{ id: 'vocab1', name: 'Lex', file: 'vocabularies/Lex.json', data: serializeVocabularyNative(VOCAB) }],
    documents: [{
      id: 'doc1', name: 'Doc One', file: 'documents/Doc One.json',
      mediaFile: 'media/Doc One.wav',
      data: serializeDocumentNative(igtDoc, { mediaFile: 'media/Doc One.wav' }),
      mediaBytes: new Uint8Array([1, 2, 3]),
    }],
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
  const walk = (layers) => layers.forEach((l) => {
    l.id = `new-${l.id}`;
    (l.tokenLayers || []).forEach((tl) => {
      tl.id = `new-${tl.id}`;
      tl.tokens = [];
      tl.vocabs = [];
      (tl.spanLayers || []).forEach((sl) => { sl.id = `new-${sl.id}`; sl.spans = []; });
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
  const record = (name, args, result) => { calls.push([name, ...args]); return result; };
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
    vocabItems: {
      create: (vocabId, form, metadata) => {
        const result = { id: fresh('item') };
        record('vocabItems.create', [vocabId, form, metadata], result);
        if (batch) batch.push(result);
        return result;
      },
    },
    vocabLinks: {
      create: (itemId, tokens, metadata) => {
        const result = { id: fresh('link') };
        record('vocabLinks.create', [itemId, tokens, metadata], result);
        if (batch) batch.push(result);
        return result;
      },
    },
    beginBatch: () => { batch = []; },
    submitBatch: async () => { const out = batch; batch = null; return out; },
    documents: {
      create: async (projectId, name, metadata) => record('documents.create', [projectId, name, metadata], { id: fresh('doc') }),
      get: async (id) => record('documents.get', [id], existingDocs.find((d) => d.id === id) ?? { id, metadata: {} }),
      delete: async (id) => record('documents.delete', [id]),
      setMetadata: async (...a) => record('documents.setMetadata', a),
      uploadMedia: async (id, file) => record('documents.uploadMedia', [id, file?.name]),
    },
    texts: {
      create: async (...a) => record('texts.create', a, { id: fresh('text') }),
    },
    tokens: {
      bulkCreate: async (specs) => record('tokens.bulkCreate', [specs], { ids: specs.map(() => fresh('tok')) }),
    },
    spans: {
      bulkCreate: async (specs) => record('spans.bulkCreate', [specs], { ids: specs.map(() => fresh('span')) }),
    },
  };
}

const callsOf = (client, name) => client.calls.filter(([n]) => n === name);

describe('deriveSetupData', () => {
  it('maps the archive schema onto the setup wizard input', () => {
    const { manifest } = buildArchive();
    const setup = deriveSetupData(manifest, 'Reimported');
    expect(setup.basicInfo).toEqual({ projectName: 'Reimported' });
    expect(setup.orthographies.orthographies).toEqual([
      { name: 'Baseline', isBaseline: true }, { name: 'Translit' },
    ]);
    expect(setup.fields.fields).toEqual(expect.arrayContaining([
      { name: 'Translation', scope: 'Sentence', isCustom: true },
      { name: 'POS', scope: 'Word', isCustom: true },
      { name: 'Phrase', scope: 'Word', isCustom: true },
      { name: 'Gloss', scope: 'Morpheme', isCustom: true },
    ]));
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
    const withWl = { ...base, schema: { ...base.schema, ignoredTokens: { type: 'unicodePunctuation', whitelist: ['-'] } } };
    expect(deriveSetupData(withWl, 'x').fields.ignoredTokens)
      .toEqual({ mode: 'unicode-punctuation', unicodePunctuationExceptions: ['-'] });
    const withBl = { ...base, schema: { ...base.schema, ignoredTokens: { type: 'blacklist', blacklist: ['.'] } } };
    expect(deriveSetupData(withBl, 'x').fields.ignoredTokens)
      .toEqual({ mode: 'explicit', explicitIgnoredTokens: ['.'] });
  });
});

describe('importVocabulary', () => {
  it('creates items in array order, stamped with their archive id', async () => {
    const client = stubClient();
    const map = await importVocabulary({
      client, vocabId: 'newvocab', vocabData: serializeVocabularyNative(VOCAB),
    });
    const creates = callsOf(client, 'vocabItems.create');
    expect(creates.map((c) => c[2])).toEqual(['perro', 'perro', 'np']); // archive order
    expect(creates[0][3]).toEqual({ gloss: 'dog', nativeImportId: 'item1' });
    expect(map.get('item1')).toMatch(/^item-/);
    expect(map.size).toBe(3);
    // field schema written
    expect(callsOf(client, 'vocabLayers.setConfig')[0].slice(1))
      .toEqual(['newvocab', 'igt', 'fields', expect.objectContaining({ gloss: { inline: true } })]);
  });

  it('resumes by nativeImportId without duplicating', async () => {
    const client = stubClient({
      existingItems: [{ id: 'kept', form: 'perro', metadata: { nativeImportId: 'item1' } }],
    });
    const map = await importVocabulary({
      client, vocabId: 'newvocab', vocabData: serializeVocabularyNative(VOCAB),
    });
    expect(map.get('item1')).toBe('kept');
    expect(callsOf(client, 'vocabItems.create')).toHaveLength(2);
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
    expect(words[0].metadata).toEqual({ 'orthog:Other': 'u', custom: 'x', 'orthog:Translit': 'pt' });
    expect(words[1].metadata).toBeUndefined();          // w2 had no metadata
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
    const links = callsOf(client, 'vocabLinks.create');
    // l1 inline on m1, l2 extra on m1, l3 extra multi-token on w1+w2.
    expect(links).toHaveLength(3);
    const multi = links.find((l) => l[2].length === 2);
    expect(multi[1]).toMatch(/^item-/);                 // mapped item id
    expect(multi[2].every((t) => t.startsWith('tok-'))).toBe(true); // mapped tokens
    expect(multi[3]).toEqual({ note: 'multi' });
    const inline = links.find((l) => l[3]?.provSource === 'flex-import');
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
    expect(callsOf(client, 'projects.setConfig')[0].slice(1))
      .toEqual(['newp', 'igt', 'autoAnalysis', { enabled: false }]);
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
