// Engine unit tests against a fake recording client — verifies the exact API
// call shapes (bulk bodies, metadata conventions, provenance stamps) and the
// resume semantics without a live server. Live verification happens in e2e.
import { describe, it, expect, beforeEach } from 'vitest';
import { deriveImportConfig, resolveTargets, importLexicon, runImport } from './importEngine.js';

// --- fixtures ----------------------------------------------------------------

const BASE_WS = 'lez';
const TRANS_WS = 'lez-translit';

const ir = {
  writingSystems: { vernacular: [BASE_WS, TRANS_WS], analysis: ['en', 'ru'] },
  wsUsage: {
    wordForms: [BASE_WS, TRANS_WS],
    wordGloss: ['en'],
    morphGloss: ['en', 'ru'],
    freeTranslation: ['en'],
    literalTranslation: [],
    note: ['en'],
  },
};

const build = {
  baselineWs: BASE_WS,
  orthographyWss: [TRANS_WS],
  documents: [
    {
      guid: 'g-doc1',
      name: '01 Мах',
      names: { [BASE_WS]: '01 Мах', en: 'The Tale' },
      source: { en: 'Rosa' },
      description: null,
      genres: ['Folktale'],
      body: 'За мах.\n',
      sentences: [{
        begin: 0, end: 8,
        freeTranslation: { en: 'I, a tale.' }, literalTranslation: null,
        notes: [{ en: 'a note' }],
      }],
      words: [
        { begin: 0, end: 2, forms: { [BASE_WS]: 'за', [TRANS_WS]: 'za' }, gloss: { en: 'I-ERG' }, pos: 'pro',
          morphemes: [{ forms: { [BASE_WS]: 'за' }, gloss: { en: '1sg' }, pos: 'pers', morphType: 'stem', senseGuid: 's1', entryGuid: 'e1' }] },
        // bare word: no analysis — should still get one default morpheme
        { begin: 3, end: 6, forms: { [BASE_WS]: 'мах' }, gloss: null, pos: null, morphemes: null },
      ],
      warnings: [],
    },
  ],
};

const lexicon = [
  { guid: 'e1', forms: { [BASE_WS]: 'за' }, citationForm: null, morphType: 'stem', homograph: 0,
    senses: [{ guid: 's1', gloss: { en: '1sg' }, definition: null, pos: 'pers' }] },
  { guid: 'e2', forms: { [BASE_WS]: 'мах' }, citationForm: null, morphType: 'root', homograph: 0,
    custom: { Plural: 'махар' },
    senses: [
      { guid: 's2', gloss: { en: 'tale' }, pos: 'n', custom: { 'Parsing Note': 'check' } },
      { guid: 's3', gloss: { en: 'story' }, pos: 'n' },
    ] },
];

const role = (r) => ({ plaid: { role: r } });
const scope = (s) => ({ igt: { scope: s } });
const project = {
  id: 'p1',
  textLayers: [{
    id: 'tl1', config: role('baseline'),
    tokenLayers: [
      { id: 'sent1', config: role('sentence'),
        spanLayers: [
          { id: 'sl-tr', name: 'Translation', config: scope('Sentence') },
          { id: 'sl-note', name: 'Note', config: scope('Sentence') },
        ] },
      { id: 'word1', config: role('word'),
        spanLayers: [
          { id: 'sl-wg', name: 'Gloss', config: scope('Word') },
          { id: 'sl-wp', name: 'POS', config: scope('Word') },
        ] },
      { id: 'morph1', config: role('morpheme'),
        spanLayers: [
          { id: 'sl-mg', name: 'Gloss', config: scope('Morpheme') },
          { id: 'sl-mg-ru', name: 'Gloss (ru)', config: scope('Morpheme') },
          { id: 'sl-mp', name: 'POS', config: scope('Morpheme') },
        ] },
    ],
  }],
};

// --- fake client ---------------------------------------------------------------

function makeFakeClient({ existingDocs = [], existingItems = [] } = {}) {
  const calls = [];
  let batch = null;
  let nextId = 0;
  const id = (p) => `${p}-${(nextId += 1)}`;
  const record = (kind, args, result) => {
    calls.push({ kind, args, result });
    if (batch) { batch.push({ result }); return undefined; }
    return Promise.resolve(result);
  };
  const docsById = new Map(existingDocs.map((d) => [d.id, d]));
  return {
    calls,
    beginBatch: () => { batch = []; },
    submitBatch: () => {
      const out = batch.map((op) => ({ body: op.result }));
      batch = null;
      return Promise.resolve(out);
    },
    projects: {
      get: () => Promise.resolve(project),
      listDocuments: () => Promise.resolve(existingDocs),
    },
    documents: {
      create: (projectId, name, metadata) => record('documents.create', { projectId, name, metadata }, { id: id('doc') }),
      get: (docId) => Promise.resolve(docsById.get(docId)),
      delete: (docId) => record('documents.delete', { docId }, {}),
      setMetadata: (docId, body) => record('documents.setMetadata', { docId, body }, {}),
    },
    texts: {
      create: (layerId, docId, body) => record('texts.create', { layerId, docId, body }, { id: id('text') }),
    },
    tokens: {
      bulkCreate: (body) => record('tokens.bulkCreate', body, { ids: body.map(() => id('tok')) }),
    },
    spans: {
      bulkCreate: (body) => record('spans.bulkCreate', body, { ids: body.map(() => id('span')) }),
    },
    vocabLayers: {
      get: () => Promise.resolve({ id: 'v1', items: existingItems }),
      setConfig: (vocabId, ns, key, value) => record('vocabLayers.setConfig', { vocabId, ns, key, value }, {}),
    },
    vocabItems: {
      create: (vocabId, form, metadata) => record('vocabItems.create', { vocabId, form, metadata }, { id: id('item') }),
    },
    vocabLinks: {
      create: (itemId, tokens, metadata) => record('vocabLinks.create', { itemId, tokens, metadata }, { id: id('link') }),
    },
  };
}

// --- tests ---------------------------------------------------------------------

describe('deriveImportConfig', () => {
  it('creates fields per analysis ws that occurs, primary unsuffixed', () => {
    const config = deriveImportConfig(ir, build);
    const names = config.fields.map((f) => `${f.scope}:${f.name}`);
    expect(names).toContain('Word:Gloss');
    expect(names).toContain('Morpheme:Gloss');
    expect(names).toContain('Morpheme:Gloss (ru)');
    expect(names).toContain('Sentence:Translation');
    expect(names).toContain('Sentence:Note');
    expect(names).not.toContain('Sentence:Literal Translation'); // no ws occurs
    expect(names).toContain('Word:POS');
    expect(names).toContain('Morpheme:POS');
    expect(config.orthographies).toEqual([{ ws: TRANS_WS, name: TRANS_WS }]);
    expect(config.baselineWs).toBe(BASE_WS);
    expect(config.documentMetadata.map((m) => m.name)).toEqual(
      expect.arrayContaining(['Title (en)', 'Source', 'Genre']));
  });
});

describe('resolveTargets', () => {
  it('maps every derived field onto an existing span layer', () => {
    const config = deriveImportConfig(ir, build);
    const targets = resolveTargets(project, config);
    expect(targets.wordLayerId).toBe('word1');
    expect(targets.morphemeLayerId).toBe('morph1');
    expect([...targets.fieldLayers.values()]).toEqual(
      expect.arrayContaining(['sl-wg', 'sl-mg', 'sl-mg-ru', 'sl-tr', 'sl-note', 'sl-wp', 'sl-mp']));
  });

  it('throws on a missing field layer', () => {
    const config = deriveImportConfig(ir, build);
    const broken = JSON.parse(JSON.stringify(project));
    broken.textLayers[0].tokenLayers[1].spanLayers = [];
    expect(() => resolveTargets(broken, config)).toThrow(/missing/);
  });
});

describe('importLexicon', () => {
  it('creates one item per sense with flex guids and skips existing', async () => {
    const client = makeFakeClient({
      existingItems: [{ id: 'old1', form: 'за', metadata: { flexSense: 's1' } }],
    });
    const map = await importLexicon({ client, vocabId: 'v1', lexicon, baselineWs: BASE_WS });
    const creates = client.calls.filter((c) => c.kind === 'vocabItems.create');
    expect(creates).toHaveLength(2); // s2 + s3; s1 already present
    expect(creates[0].args.metadata).toMatchObject({
      flexEntry: 'e2', flexSense: 's2', gloss: 'tale', pos: 'n', morphType: 'root',
      Plural: 'махар', 'Parsing Note': 'check',
    });
    // gloss first: the popover's no-config fallback shows the first value
    expect(Object.keys(creates[0].args.metadata)[0]).toBe('gloss');
    expect(map.get('s1')).toBe('old1');
    expect(map.get('s2')).toBeTruthy();
  });

  it('declares the vocab field schema (gloss/pos inline + custom fields)', async () => {
    const client = makeFakeClient();
    await importLexicon({ client, vocabId: 'v1', lexicon, baselineWs: BASE_WS });
    const cfg = client.calls.find((c) => c.kind === 'vocabLayers.setConfig');
    expect(cfg.args).toMatchObject({ vocabId: 'v1', ns: 'igt', key: 'fields' });
    expect(cfg.args.value).toEqual({
      gloss: { inline: true },
      pos: { inline: true },
      morphType: { inline: false },
      Plural: { inline: false },
      'Parsing Note': { inline: false },
    });
  });
});

describe('runImport', () => {
  let client, config;
  beforeEach(() => {
    config = deriveImportConfig(ir, build);
  });

  it('imports a document with the right call shapes', async () => {
    client = makeFakeClient();
    const results = await runImport({ client, projectId: 'p1', build, lexicon, config, vocabId: 'v1' });
    expect(results).toMatchObject({ imported: 1, skipped: 0, redone: 0 });

    const bulks = client.calls.filter((c) => c.kind === 'tokens.bulkCreate');
    expect(bulks).toHaveLength(3); // sentences, words, morphemes
    const [sentences, words, morphemes] = bulks.map((b) => b.args);

    expect(sentences).toEqual([{ tokenLayerId: 'sent1', text: expect.any(String), begin: 0, end: 8 }]);

    // word orthography metadata under orthog:<name>
    expect(words[0].metadata).toEqual({ [`orthog:${TRANS_WS}`]: 'za' });
    expect(words[1].metadata).toBeUndefined();

    // morphemes: full word extent, 1-based precedence, form + morphType;
    // the bare word gets a default morpheme with no metadata
    expect(morphemes).toHaveLength(2);
    expect(morphemes[0]).toMatchObject({
      tokenLayerId: 'morph1', begin: 0, end: 2, precedence: 1,
      metadata: { form: 'за', morphType: 'stem' },
    });
    expect(morphemes[1]).toMatchObject({ begin: 3, end: 6, precedence: 1 });
    expect(morphemes[1].metadata).toBeUndefined();

    // spans: word gloss + word pos + morpheme gloss + morpheme pos +
    // sentence translation + note (no ru morph gloss — value absent).
    // One bulkCreate per layer — the endpoint rejects mixed-layer batches.
    const spanCalls = client.calls.filter((c) => c.kind === 'spans.bulkCreate');
    for (const c of spanCalls) {
      expect(new Set(c.args.map((s) => s.spanLayerId)).size).toBe(1);
    }
    const byLayer = Object.groupBy(spanCalls.flatMap((c) => c.args), (s) => s.spanLayerId);
    expect(byLayer['sl-wg'][0].value).toBe('I-ERG');
    expect(byLayer['sl-wp'][0].value).toBe('pro');
    expect(byLayer['sl-mg'][0].value).toBe('1sg');
    expect(byLayer['sl-mp'][0].value).toBe('pers');
    expect(byLayer['sl-tr'][0].value).toBe('I, a tale.');
    expect(byLayer['sl-note'][0].value).toBe('a note');
    expect(byLayer['sl-mg-ru']).toBeUndefined();

    // vocab link on the analyzed morpheme only, stamped confirmed
    const links = client.calls.filter((c) => c.kind === 'vocabLinks.create');
    expect(links).toHaveLength(1);
    expect(links[0].args.metadata).toEqual({ prov: 'inferred', provSource: 'flex-import', provConfirmed: true });

    // document done-marker written last, with FLEx metadata preserved
    const last = client.calls[client.calls.length - 1];
    expect(last.kind).toBe('documents.setMetadata');
    expect(last.args.body).toMatchObject({ flexImported: true, Source: 'Rosa', Genre: 'Folktale', 'Title (en)': 'The Tale' });
  });

  it('skips done documents and redoes half-imported ones', async () => {
    client = makeFakeClient({
      existingDocs: [{ id: 'doc-old', name: '01 Мах', metadata: {} }], // no done marker
    });
    const results = await runImport({ client, projectId: 'p1', build, lexicon, config, vocabId: 'v1' });
    expect(results).toMatchObject({ imported: 1, redone: 1, skipped: 0 });
    expect(client.calls.some((c) => c.kind === 'documents.delete')).toBe(true);

    client = makeFakeClient({
      existingDocs: [{ id: 'doc-old', name: '01 Мах', metadata: { flexImported: true } }],
    });
    const results2 = await runImport({ client, projectId: 'p1', build, lexicon, config, vocabId: 'v1' });
    expect(results2).toMatchObject({ imported: 0, skipped: 1, redone: 0 });
    expect(client.calls.some((c) => c.kind === 'documents.create')).toBe(false);
  });
});
