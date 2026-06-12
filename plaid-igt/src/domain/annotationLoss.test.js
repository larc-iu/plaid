import { describe, it, expect } from 'vitest';
import { countAnnotationLossForWord } from './annotationLoss.js';

// A shared IGT+UD-shaped layerInfo: the word carries an IGT gloss, its IGT
// morpheme a gloss, and UD's syntactic-word layer (nested under words too)
// carries a UPOS span, a Lemma span, and a dependency relation on that Lemma —
// all of which the word-delete cascade destroys.
const make = () => {
  const word = { id: 'w1', begin: 0, end: 5 };
  const wordLayer = {
    id: 'tl-word',
    tokens: [word, { id: 'w2', begin: 6, end: 9 }],
    spanLayers: [
      { id: 'sl-wgloss', spans: [{ id: 's1', tokens: ['w1'], value: 'word-gloss' }] },
    ],
  };
  const igtMorphLayer = {
    id: 'tl-igt-morph',
    parentTokenLayer: 'tl-word',
    tokens: [{ id: 'm1', begin: 0, end: 5 }],
    spanLayers: [
      { id: 'sl-mgloss', spans: [{ id: 's2', tokens: ['m1'], value: 'morph-gloss' }] },
    ],
  };
  const udSynLayer = {
    id: 'tl-ud-syn',
    parentTokenLayer: 'tl-word',
    tokens: [{ id: 'sw1', begin: 0, end: 5 }, { id: 'sw2', begin: 6, end: 9 }],
    spanLayers: [
      { id: 'sl-upos', spans: [{ id: 's3', tokens: ['sw1'], value: 'NOUN' }] },
      {
        id: 'sl-lemma',
        spans: [
          { id: 's4', tokens: ['sw1'], value: 'lemma1' },
          { id: 's5', tokens: ['sw2'], value: 'lemma2' },
        ],
        relationLayers: [
          { id: 'rl-dep', relations: [
            { id: 'r1', source: 's5', target: 's4', value: 'det' },     // dies (target dies)
            { id: 'r2', source: 's5', target: 's5', value: 'root' },    // survives
          ] },
        ],
      },
    ],
  };
  const layerInfo = {
    primaryTextLayer: { tokenLayers: [wordLayer, igtMorphLayer, udSynLayer] },
    primaryTokenLayer: wordLayer,
  };
  const vocabularies = {
    v1: { id: 'v1', vocabLinks: [
      { id: 'l1', tokens: ['m1'] },          // dies with the IGT morpheme
      { id: 'l2', tokens: ['w2'] },          // other word — survives
    ] },
  };
  return { layerInfo, vocabularies, word };
};

describe('countAnnotationLossForWord', () => {
  it('counts spans, relations, and links across ALL apps layers', () => {
    const { layerInfo, vocabularies, word } = make();
    // dying: w1, m1, sw1 -> spans s1, s2, s3, s4 + relation r1; link l1
    expect(countAnnotationLossForWord(layerInfo, vocabularies, word))
      .toEqual({ annotations: 5, links: 1 });
  });

  it('reports zero for an unannotated token (instant delete path)', () => {
    const { layerInfo, vocabularies } = make();
    const bare = { id: 'w3', begin: 10, end: 12 };
    layerInfo.primaryTokenLayer.tokens.push(bare);
    expect(countAnnotationLossForWord(layerInfo, vocabularies, bare))
      .toEqual({ annotations: 0, links: 0 });
  });

  it('handles missing inputs gracefully', () => {
    expect(countAnnotationLossForWord(null, {}, { id: 'x', begin: 0, end: 1 }))
      .toEqual({ annotations: 0, links: 0 });
    expect(countAnnotationLossForWord({ primaryTokenLayer: { id: 't', tokens: [] } }, null, null))
      .toEqual({ annotations: 0, links: 0 });
  });
});
