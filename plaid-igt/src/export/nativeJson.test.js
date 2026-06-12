import { describe, it, expect } from 'vitest';
import { IgtDocument } from '../domain/IgtDocument.js';
import {
  buildProjectFile, serializeVocabularyNative, serializeDocumentNative,
  NATIVE_FORMAT_VERSION,
} from './nativeJson.js';

const role = (r) => ({ plaid: { role: r } });

// A raw document exercising every loss trap. Morphemes are full-width (same
// extent as their word, ordered by precedence) per the IGT data model; the
// segment text lives in metadata.form. Body: "perros corren. extra" with the
// sentence covering [0,14) and 'extra' [15,20) outside it.
function buildRaw() {
  return {
    id: 'doc1', name: 'Doc One', version: 7,
    metadata: { Source: 'notes', flexImported: true, custom: { k: 1 } }, // trap (a)
    textLayers: [{
      id: 'tl1', config: role('baseline'),
      text: { id: 'text1', body: 'perros corren. extra', metadata: { lang: 'es' } },
      tokenLayers: [
        {
          id: 'wl', config: { ...role('word'), igt: { orthographies: [{ name: 'Translit' }] } },
          tokens: [
            { id: 'w1', begin: 0, end: 6, metadata: { 'orthog:Translit': 'pt', 'orthog:Other': 'u', custom: 'x' } },
            { id: 'w2', begin: 7, end: 13, metadata: {} },
            { id: 'w3', begin: 15, end: 20, metadata: { stray: true } }, // outside the sentence — trap (f)
          ],
          spanLayers: [
            {
              id: 'slPOS', name: 'POS', config: { igt: { scope: 'Word' } },
              spans: [{ id: 'sp1', tokens: ['w1'], value: 'NOUN', metadata: { prov: 'inferred', provConfirmed: true } }],
            },
            {
              id: 'slPhrase', name: 'Phrase', config: { igt: { scope: 'Word' } },
              spans: [{ id: 'sp2', tokens: ['w1', 'w2'], value: 'NP' }], // one span, two tokens — trap (h)
            },
            {
              id: 'slMystery', name: 'Mystery', config: {}, // no scope: invisible to the derived view
              spans: [{ id: 'sp3', tokens: ['w1'], value: '?' }],
            },
          ],
          vocabs: [{
            id: 'vocab1', name: 'Lex',
            vocabLinks: [
              { id: 'l1', tokens: ['m1'], vocabItem: { id: 'item1', form: 'perro' }, metadata: { prov: 'inferred', provSource: 'flex-import' } },
              { id: 'l2', tokens: ['m1'], vocabItem: { id: 'item2' } },        // second link on m1 — trap (b)
              { id: 'l3', tokens: ['w1', 'w2'], vocabItem: { id: 'item3' }, metadata: { note: 'multi' } }, // trap (b)
            ],
          }],
        },
        {
          id: 'sl', config: role('sentence'),
          tokens: [{ id: 's1', begin: 0, end: 14, metadata: { speaker: 'A' } }],
          spanLayers: [{
            id: 'slTr', name: 'Translation', config: { igt: { scope: 'Sentence' } },
            spans: [
              { id: 'sp4', tokens: ['s1'], value: 'The dogs run.' },
              { id: 'sp5', tokens: ['s1'], value: 'dup' }, // duplicate per layer+token — trap (g)
            ],
          }],
        },
        {
          id: 'ml', config: role('morpheme'),
          tokens: [
            { id: 'm1', begin: 0, end: 6, precedence: 1, metadata: { form: 'perro', morphType: 'stem' } },
            { id: 'm2', begin: 0, end: 6, precedence: 2, metadata: { form: '' } },  // '' is meaningful
            { id: 'm3', begin: 7, end: 13, precedence: 1, metadata: {} },           // no form key at all
            { id: 'mOrphan', begin: 15, end: 18, precedence: 1, metadata: { form: 'or' } }, // matches no word extent
          ],
          spanLayers: [{
            id: 'slGloss', name: 'Gloss', config: { igt: { scope: 'Morpheme' } },
            spans: [{ id: 'sp6', tokens: ['m1'], value: 'dog' }],
          }],
        },
        {
          id: 'al', config: role('time-alignment'),
          tokens: [{ id: 'a1', begin: 0, end: 14, metadata: { timeBegin: 1.25, timeEnd: 3.5, note: 'x' } }],
        },
      ],
    }],
  };
}

const buildProject = () => ({
  id: 'p1', name: 'Proj',
  config: {
    igt: {
      documentMetadata: [{ name: 'Source' }],
      autoAnalysis: { enabled: false },
    },
  },
  textLayers: buildRaw().textLayers,
});

const makeDoc = (raw = buildRaw()) =>
  new IgtDocument({ raw, project: buildProject(), vocabularies: {} });

describe('serializeDocumentNative', () => {
  const out = serializeDocumentNative(makeDoc(), { mediaFile: 'media/Doc One.wav' });

  it('serializes identity, baseline, and raw metadata wholesale', () => {
    expect(out.id).toBe('doc1');
    expect(out.version).toBe(7);
    expect(out.mediaFile).toBe('media/Doc One.wav');
    expect(out.metadata).toEqual({ Source: 'notes', flexImported: true, custom: { k: 1 } });
    expect(out.baseline).toEqual({ textId: 'text1', body: 'perros corren. extra', metadata: { lang: 'es' } });
  });

  it('builds the sentence tree with field entries carrying span ids and provenance', () => {
    expect(out.sentences).toHaveLength(1);
    const s = out.sentences[0];
    expect(s).toMatchObject({ id: 's1', begin: 0, end: 14, metadata: { speaker: 'A' } });
    expect(s.fields.Translation).toEqual({ id: 'sp4', value: 'The dogs run.' });
    const w1 = s.words[0];
    expect(w1.fields.POS).toEqual({
      id: 'sp1', value: 'NOUN', metadata: { prov: 'inferred', provConfirmed: true },
    });
  });

  it('lifts configured orthographies out of token metadata, keeps the rest', () => {
    const w1 = out.sentences[0].words[0];
    expect(w1.orthographies).toEqual({ Translit: 'pt' });
    expect(w1.metadata).toEqual({ 'orthog:Other': 'u', custom: 'x' });
    expect(out.sentences[0].words[1].orthographies).toEqual({}); // no key → unset, not ''
  });

  it('represents a multi-token span as repeated entries sharing one span id', () => {
    const [w1, w2] = out.sentences[0].words;
    expect(w1.fields.Phrase.id).toBe('sp2');
    expect(w2.fields.Phrase.id).toBe('sp2');
  });

  it('emits morphemes with precedence and the form present-vs-absent distinction', () => {
    const morphemes = out.sentences[0].words[0].morphemes;
    expect(morphemes.map((m) => m.precedence)).toEqual([1, 2]);
    expect(morphemes[0]).toMatchObject({ id: 'm1', form: 'perro', morphType: 'stem' });
    expect(morphemes[0].fields.Gloss).toEqual({ id: 'sp6', value: 'dog' });
    expect(morphemes[1].form).toBe('');                      // present but empty
    const m3 = out.sentences[0].words[1].morphemes[0];
    expect('form' in m3).toBe(false);                        // key absent entirely
    expect('morphType' in m3).toBe(false);
  });

  it('inlines the first single-token vocab link with full metadata; rest go to extras', () => {
    const m1 = out.sentences[0].words[0].morphemes[0];
    expect(m1.vocab).toEqual({
      linkId: 'l1', vocabId: 'vocab1', itemId: 'item1',
      metadata: { prov: 'inferred', provSource: 'flex-import' },
    });
    expect(out.extraVocabLinks).toEqual([
      { id: 'l2', vocabId: 'vocab1', itemId: 'item2', tokens: ['m1'] },
      { id: 'l3', vocabId: 'vocab1', itemId: 'item3', tokens: ['w1', 'w2'], metadata: { note: 'multi' } },
    ]);
  });

  it('catches orphan tokens and surplus/unscoped spans in the completeness sweep', () => {
    expect(out.orphanTokens).toEqual([
      { layer: 'word', id: 'w3', begin: 15, end: 20, metadata: { stray: true } },
      { layer: 'morpheme', id: 'mOrphan', begin: 15, end: 18, precedence: 1, metadata: { form: 'or' } },
    ]);
    expect(out.extraSpans).toEqual(expect.arrayContaining([
      { id: 'sp3', layer: { name: 'Mystery', scope: null }, tokens: ['w1'], value: '?' },
      { id: 'sp5', layer: { name: 'Translation', scope: 'Sentence' }, tokens: ['s1'], value: 'dup' },
    ]));
    expect(out.extraSpans).toHaveLength(2);
  });

  it('lifts alignment times (seconds) and keeps residual metadata', () => {
    expect(out.alignment).toEqual([
      { id: 'a1', begin: 0, end: 14, timeBegin: 1.25, timeEnd: 3.5, metadata: { note: 'x' } },
    ]);
  });

  it('degrades to empty structures on a bare document', () => {
    const bare = serializeDocumentNative(makeDoc({ id: 'd', textLayers: [] }));
    expect(bare).toMatchObject({
      id: 'd', mediaFile: null, metadata: {}, sentences: [], alignment: [],
      extraVocabLinks: [], extraSpans: [], orphanTokens: [],
    });
    expect(bare.baseline.body).toBe('');
  });
});

describe('serializeVocabularyNative', () => {
  it('sorts items by id (creation order) and normalizes fields', () => {
    const out = serializeVocabularyNative({
      id: 'v1', name: 'Lex',
      config: { igt: { fields: { gloss: { inline: true }, custom: { inline: false } } } },
      items: [
        { id: 'b', form: 'zeta', metadata: { gloss: 'z' } },
        { id: 'a', form: 'alpha', metadata: {} },
      ],
    });
    expect(out.fields).toEqual([
      { name: 'morphType', inline: false },  // immutable core fields pinned first
      { name: 'gloss', inline: true },
      { name: 'custom', inline: false },
    ]);
    expect(out.items).toEqual([
      { id: 'a', form: 'alpha' },                          // empty metadata omitted
      { id: 'b', form: 'zeta', metadata: { gloss: 'z' } },
    ]);
  });
});

describe('buildProjectFile', () => {
  it('emits version, schema, layer map, and the manifest', () => {
    const out = buildProjectFile({
      project: buildProject(),
      documents: [{ id: 'doc1', name: 'Doc One', file: 'documents/Doc One.json', mediaFile: null }],
      vocabularies: [{ id: 'vocab1', name: 'Lex', file: 'vocabularies/Lex.json' }],
      asOf: null,
      exportedAt: '2026-06-12T00:00:00.000Z',
    });
    expect(out.format).toBe('plaid-igt');
    expect(out.formatVersion).toBe(NATIVE_FORMAT_VERSION);
    expect(out.project).toEqual({ id: 'p1', name: 'Proj' });
    expect(out.schema).toEqual({
      orthographies: [{ name: 'Translit' }],
      fields: {
        sentence: [{ name: 'Translation' }],
        word: [{ name: 'POS' }, { name: 'Phrase' }],
        morpheme: [{ name: 'Gloss' }],
      },
      ignoredTokens: null,
      documentMetadata: [{ name: 'Source' }],
      autoAnalysis: { enabled: false },
    });
    expect(out.layers).toMatchObject({
      baselineText: 'tl1', sentence: 'sl', word: 'wl', morpheme: 'ml', timeAlignment: 'al',
    });
    expect(out.layers.spanLayers).toEqual(expect.arrayContaining([
      { id: 'slMystery', name: 'Mystery', scope: null },
      { id: 'slGloss', name: 'Gloss', scope: 'Morpheme' },
    ]));
    expect(out.documents).toHaveLength(1);
    expect(out.vocabularies).toHaveLength(1);
  });

  it('passes through null autoAnalysis without baking defaults', () => {
    const project = buildProject();
    delete project.config.igt.autoAnalysis;
    const out = buildProjectFile({
      project, documents: [], vocabularies: [], exportedAt: 'x',
    });
    expect(out.schema.autoAnalysis).toBeNull();
  });
});
