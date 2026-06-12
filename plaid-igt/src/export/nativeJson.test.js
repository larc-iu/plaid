import { describe, it, expect } from 'vitest';
import { IgtDocument } from '../domain/IgtDocument.js';
import { makeNativeRaw as buildRaw, makeNativeProject as buildProject } from './testFixtures.js';
import {
  buildProjectFile, serializeVocabularyNative, serializeDocumentNative,
  NATIVE_FORMAT_VERSION,
} from './nativeJson.js';

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

  it('inlines the LAST single-token vocab link (what the editor shows); rest go to extras', () => {
    const m1 = out.sentences[0].words[0].morphemes[0];
    expect(m1.vocab).toEqual({ linkId: 'l2', vocabId: 'vocab1', itemId: 'item2' });
    expect(out.extraVocabLinks).toEqual([
      { id: 'l1', vocabId: 'vocab1', itemId: 'item1', tokens: ['m1'], metadata: { prov: 'inferred', provSource: 'flex-import' } },
      { id: 'l3', vocabId: 'vocab1', itemId: 'item3', tokens: ['w1', 'w2'], metadata: { note: 'multi' } },
    ]);
  });

  it('archives links on tokens outside the tree instead of dropping them', () => {
    const raw = buildRaw();
    raw.textLayers[0].tokenLayers[0].vocabs[0].vocabLinks.push(
      { id: 'lOrphan', tokens: ['w3'], vocabItem: { id: 'item1' }, metadata: { prov: 'inferred' } }, // orphan word
      { id: 'lSent', tokens: ['s1'], vocabItem: { id: 'item1' } },                                   // sentence token
    );
    const o = serializeDocumentNative(makeDoc(raw));
    const ids = o.extraVocabLinks.map((l) => l.id);
    expect(ids).toContain('lOrphan');
    expect(ids).toContain('lSent');
    expect(o.extraVocabLinks.find((l) => l.id === 'lOrphan').metadata).toEqual({ prov: 'inferred' });
  });

  it('catches orphan tokens and surplus/unscoped spans in the completeness sweep', () => {
    expect(out.orphanTokens).toEqual([
      { layer: 'word', id: 'w3', begin: 15, end: 20, metadata: { stray: true } },
      { layer: 'morpheme', id: 'mOrphan', begin: 15, end: 18, precedence: 1, metadata: { form: 'or' } },
    ]);
    expect(out.extraSpans).toEqual(expect.arrayContaining([
      { id: 'sp3', layer: { id: 'slMystery', name: 'Mystery', scope: null }, tokens: ['w1'], value: '?' },
      { id: 'sp5', layer: { id: 'slTr', name: 'Translation', scope: 'Sentence' }, tokens: ['s1'], value: 'dup' },
    ]));
    expect(out.extraSpans).toHaveLength(2);
  });

  it('records a tree span whose membership reaches an orphan token in extraSpans too', () => {
    const raw = buildRaw();
    raw.textLayers[0].tokenLayers[0].spanLayers[0].spans.push(
      { id: 'spMixed', tokens: ['w1', 'w3'], value: 'mixed' }); // w3 is outside the sentence
    const o = serializeDocumentNative(makeDoc(raw));
    // Reachable from w1's fields… but the full membership lives in extraSpans.
    const mixed = o.extraSpans.find((s) => s.id === 'spMixed');
    expect(mixed.tokens).toEqual(['w1', 'w3']);
  });

  it('sweeps span layers on the time-alignment layer', () => {
    const raw = buildRaw();
    raw.textLayers[0].tokenLayers[3].spanLayers = [{
      id: 'slAl', name: 'AlignNote', config: {},
      spans: [{ id: 'spAl', tokens: ['a1'], value: 'noisy' }],
    }];
    const o = serializeDocumentNative(makeDoc(raw));
    expect(o.extraSpans.find((s) => s.id === 'spAl')).toEqual({
      id: 'spAl', layer: { id: 'slAl', name: 'AlignNote', scope: null }, tokens: ['a1'], value: 'noisy',
    });
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
