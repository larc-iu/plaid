import { describe, it, expect } from 'vitest';
import {
  countAnnotationLossForRange,
  countAnnotationLossForWord,
  countReTokenizeLoss,
} from './annotationLoss.js';

// A shared IGT+UD-shaped layerInfo: the word carries an IGT gloss, its IGT
// morpheme a gloss, and UD's syntactic-word layer (nested under words too)
// carries a UPOS span, a Lemma span, and a dependency relation on that Lemma —
// all of which the word-delete cascade destroys.
const make = () => {
  const word = { id: 'w1', begin: 0, end: 5 };
  const wordLayer = {
    id: 'tl-word',
    tokens: [word, { id: 'w2', begin: 6, end: 9 }],
    spanLayers: [{ id: 'sl-wgloss', spans: [{ id: 's1', tokens: ['w1'], value: 'word-gloss' }] }],
  };
  const igtMorphLayer = {
    id: 'tl-igt-morph',
    parentTokenLayer: 'tl-word',
    tokens: [{ id: 'm1', begin: 0, end: 5 }],
    spanLayers: [{ id: 'sl-mgloss', spans: [{ id: 's2', tokens: ['m1'], value: 'morph-gloss' }] }],
  };
  const udSynLayer = {
    id: 'tl-ud-syn',
    parentTokenLayer: 'tl-word',
    tokens: [
      { id: 'sw1', begin: 0, end: 5 },
      { id: 'sw2', begin: 6, end: 9 },
    ],
    spanLayers: [
      { id: 'sl-upos', spans: [{ id: 's3', tokens: ['sw1'], value: 'NOUN' }] },
      {
        id: 'sl-lemma',
        spans: [
          { id: 's4', tokens: ['sw1'], value: 'lemma1' },
          { id: 's5', tokens: ['sw2'], value: 'lemma2' },
        ],
        relationLayers: [
          {
            id: 'rl-dep',
            relations: [
              { id: 'r1', source: 's5', target: 's4', value: 'det' }, // dies (target dies)
              { id: 'r2', source: 's5', target: 's5', value: 'root' }, // survives
            ],
          },
        ],
      },
    ],
  };
  const layerInfo = {
    primaryTextLayer: { tokenLayers: [wordLayer, igtMorphLayer, udSynLayer] },
    primaryTokenLayer: wordLayer,
  };
  const vocabularies = {
    v1: {
      id: 'v1',
      vocabLinks: [
        { id: 'l1', tokens: ['m1'] }, // dies with the IGT morpheme
        { id: 'l2', tokens: ['w2'] }, // other word — survives
      ],
    },
  };
  return { layerInfo, vocabularies, word };
};

describe('countAnnotationLossForWord', () => {
  it('counts spans, relations, and links across ALL apps layers', () => {
    const { layerInfo, vocabularies, word } = make();
    // dying: w1, m1, sw1 -> spans s1, s2, s3, s4 + relation r1; link l1
    expect(countAnnotationLossForWord(layerInfo, vocabularies, word)).toEqual({
      annotations: 5,
      links: 1,
    });
  });

  it('reports zero for an unannotated token (instant delete path)', () => {
    const { layerInfo, vocabularies } = make();
    const bare = { id: 'w3', begin: 10, end: 12 };
    layerInfo.primaryTokenLayer.tokens.push(bare);
    expect(countAnnotationLossForWord(layerInfo, vocabularies, bare)).toEqual({
      annotations: 0,
      links: 0,
    });
  });

  it('handles missing inputs gracefully', () => {
    expect(countAnnotationLossForWord(null, {}, { id: 'x', begin: 0, end: 1 })).toEqual({
      annotations: 0,
      links: 0,
    });
    expect(
      countAnnotationLossForWord({ primaryTokenLayer: { id: 't', tokens: [] } }, null, null),
    ).toEqual({ annotations: 0, links: 0 });
  });
});

// A segment's trash on the Media tab deletes its text when this is zero, and
// asks first when it is not.
describe('countAnnotationLossForRange', () => {
  it('is the sum over every word the stretch touches, even partly', () => {
    const { layerInfo, vocabularies, word } = make();
    const one = countAnnotationLossForWord(layerInfo, vocabularies, word);
    expect(countAnnotationLossForRange(layerInfo, vocabularies, 0, 6)).toEqual(one);
    expect(countAnnotationLossForRange(layerInfo, vocabularies, 3, 6)).toEqual(one);
    // Both words: w2 brings its own count (s5, the two relations grounded on
    // it, and link l2).
    const two = countAnnotationLossForWord(layerInfo, vocabularies, { id: 'w2', begin: 6, end: 9 });
    expect(two).toEqual({ annotations: 3, links: 1 });
    expect(countAnnotationLossForRange(layerInfo, vocabularies, 0, 9)).toEqual({
      annotations: one.annotations + two.annotations,
      links: one.links + two.links,
    });
    expect(countAnnotationLossForRange(layerInfo, vocabularies, 5, 6)).toEqual({
      annotations: 0,
      links: 0,
    });
  });

  it('adds the spans of a sentence lying wholly inside the stretch, not one it cuts', () => {
    const { layerInfo, vocabularies } = make();
    const withSentence = {
      ...layerInfo,
      sentenceTokenLayer: { tokens: [{ id: 'sent1', begin: 0, end: 9 }] },
      spanLayers: {
        sentence: [{ spans: [{ id: 'tr', tokens: ['sent1'], value: 'a translation' }] }],
      },
    };
    const plain = countAnnotationLossForRange(layerInfo, vocabularies, 0, 9);
    const whole = countAnnotationLossForRange(withSentence, vocabularies, 0, 9);
    expect(whole.annotations).toBe(plain.annotations + 1); // the translation
    // A stretch that cuts the sentence leaves the translation out of the count.
    expect(countAnnotationLossForRange(withSentence, vocabularies, 0, 6)).toEqual(
      countAnnotationLossForRange(layerInfo, vocabularies, 0, 6),
    );
  });
});

// A tokenizer service resets a one-sentence document's sentence partition,
// and the server takes every token nested under the sentence with it. The
// confirm asks first whenever that loses anything.
describe('countReTokenizeLoss', () => {
  const oneSentence = ({ word = {}, morph = {}, extra = [] } = {}) => {
    const sentenceLayer = { id: 'tl-sent', tokens: [{ id: 'sent1', begin: 0, end: 9 }] };
    const wordLayer = {
      id: 'tl-word',
      parentTokenLayer: 'tl-sent',
      tokens: [
        { id: 'w1', begin: 0, end: 5, metadata: word },
        { id: 'w2', begin: 6, end: 9 },
      ],
      spanLayers: [],
    };
    const morphLayer = {
      id: 'tl-morph',
      parentTokenLayer: 'tl-word',
      tokens: [{ id: 'm1', begin: 0, end: 5, metadata: morph }],
      spanLayers: [],
    };
    return {
      primaryTextLayer: { tokenLayers: [sentenceLayer, wordLayer, morphLayer, ...extra] },
      sentenceTokenLayer: sentenceLayer,
      primaryTokenLayer: wordLayer,
      morphemeTokenLayer: morphLayer,
      spanLayers: {},
    };
  };

  it('is zero for words nobody has annotated', () => {
    expect(countReTokenizeLoss(oneSentence(), {})).toEqual({ annotations: 0, links: 0 });
  });

  it('counts a segmentation with no gloss on it', () => {
    const info = oneSentence({ morph: { form: 'Mimm', morphType: 'stem' } });
    expect(countReTokenizeLoss(info, {})).toEqual({ annotations: 1, links: 0 });
  });

  it('counts an orthography line on a word', () => {
    const info = oneSentence({ word: { 'orthog:Translit': 'Mimme' } });
    expect(countReTokenizeLoss(info, {})).toEqual({ annotations: 1, links: 0 });
  });

  it('does not count provenance alone', () => {
    const info = oneSentence({ word: { prov: 'inferred', provSource: 'service:x' } });
    expect(countReTokenizeLoss(info, {})).toEqual({ annotations: 0, links: 0 });
  });

  it("counts another app's layers nested under the words", () => {
    const ud = {
      id: 'tl-ud',
      parentTokenLayer: 'tl-word',
      tokens: [{ id: 'sw1', begin: 0, end: 5 }],
      spanLayers: [
        {
          id: 'sl-lemma',
          spans: [{ id: 'l1', tokens: ['sw1'], value: 'x' }],
          relationLayers: [{ id: 'rl', relations: [{ id: 'r1', source: 'l1', target: 'l1' }] }],
        },
      ],
    };
    const info = oneSentence({ extra: [ud] });
    const vocabularies = { v: { vocabLinks: [{ id: 'k', tokens: ['m1'] }] } };
    expect(countReTokenizeLoss(info, vocabularies)).toEqual({ annotations: 2, links: 1 });
  });

  // REV-SVC-2: a person's merge or split of a machine tokenizer's token leaves
  // provenance keys only, verified or contributed.
  it('counts a stamped token a person verified or contributed', () => {
    const machine = { prov: 'inferred', provSource: 'service:whisper' };
    const verified = oneSentence({ word: { ...machine, provConfirmed: true } });
    expect(countReTokenizeLoss(verified, {})).toEqual({ annotations: 1, links: 0 });
    const contributed = oneSentence({ word: { prov: 'contributed', provSource: 'user:b@x.com' } });
    expect(countReTokenizeLoss(contributed, {})).toEqual({ annotations: 1, links: 0 });
    const merged = oneSentence();
    merged.sentenceTokenLayer.tokens[0].metadata = { ...machine, provConfirmed: true };
    expect(countReTokenizeLoss(merged, {})).toEqual({ annotations: 1, links: 0 });
  });

  it('is zero when the document has more than one sentence', () => {
    const info = oneSentence({ morph: { form: 'Mimm' } });
    info.sentenceTokenLayer.tokens.push({ id: 'sent2', begin: 9, end: 9 });
    expect(countReTokenizeLoss(info, {})).toEqual({ annotations: 0, links: 0 });
  });
});
