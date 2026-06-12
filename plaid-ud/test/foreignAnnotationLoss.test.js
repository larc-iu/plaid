// foreignAnnotationLossForWord: counts the OTHER apps' annotations a word
// delete would cascade away (spans + vocab links on the word and on foreign
// tokens nested under it), while ignoring UD's own (visible) material.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { foreignAnnotationLossForWord } from '../src/utils/udLayerUtils.js';

// A shared UD+IGT-shaped layerInfo: word layer with IGT Gloss spans + vocab
// links, an IGT morpheme layer nested under it (glosses + links), UD's
// syntactic-word layer nested too (its UPOS span must NOT count).
const make = () => {
  const word = { id: 'w1', begin: 0, end: 5 };
  const otherWord = { id: 'w2', begin: 6, end: 9 };
  const igtMorph = { id: 'm1', begin: 0, end: 5 };
  const igtMorphOther = { id: 'm2', begin: 6, end: 9 };
  const udSyn = { id: 'sw1', begin: 0, end: 5 };

  const uposLayer = { id: 'sl-upos', spans: [{ id: 'su', tokens: ['sw1'], value: 'NOUN' }] };
  const wordTokenLayer = {
    id: 'tl-word',
    tokens: [word, otherWord],
    spanLayers: [
      { id: 'sl-wgloss', spans: [
        { id: 's1', tokens: ['w1'], value: 'word-gloss' },
        { id: 's2', tokens: ['w2'], value: 'other-word-gloss' },
      ] },
    ],
    vocabs: [{ id: 'v1', vocabLinks: [{ id: 'l1', tokens: ['w1'] }] }],
  };
  const igtMorphLayer = {
    id: 'tl-igt-morph',
    parentTokenLayer: 'tl-word',
    tokens: [igtMorph, igtMorphOther],
    spanLayers: [
      { id: 'sl-mgloss', spans: [
        { id: 's3', tokens: ['m1'], value: 'morph-gloss' },
        { id: 's4', tokens: ['m2'], value: 'other-morph-gloss' },
      ] },
    ],
    vocabs: [{ id: 'v1', vocabLinks: [
      { id: 'l2', tokens: ['m1'] },
      { id: 'l3', tokens: ['m2'] },
    ] }],
  };
  const udSynLayer = {
    id: 'tl-ud-syn',
    parentTokenLayer: 'tl-word',
    tokens: [udSyn],
    spanLayers: [uposLayer],
  };
  const sentenceLayer = {
    id: 'tl-sent',
    tokens: [{ id: 'snt1', begin: 0, end: 9 }],
    spanLayers: [{ id: 'sl-trans', spans: [{ id: 's5', tokens: ['snt1'], value: 'translation' }] }],
  };

  return {
    word,
    layerInfo: {
      textLayer: { tokenLayers: [sentenceLayer, wordTokenLayer, igtMorphLayer, udSynLayer] },
      sentenceTokenLayer: sentenceLayer,
      wordTokenLayer,
      morphemeTokenLayer: udSynLayer,
      uposLayer,
    },
  };
};

test('counts foreign spans + links on the word and its nested foreign tokens', () => {
  const { word, layerInfo } = make();
  // dying: w1 + m1 (+ sw1, whose UPOS span is UD's own and excluded)
  // foreign spans: word-gloss (s1) + morph-gloss (s3); links: l1 + l2
  assert.deepEqual(foreignAnnotationLossForWord(layerInfo, word), { spans: 2, links: 2 });
});

test('a word with nothing foreign attached reports zero (no dialog)', () => {
  const { layerInfo } = make();
  // w2/m2 carry annotations — but delete a word at an unannotated extent
  const bare = { id: 'w3', begin: 10, end: 12 };
  layerInfo.wordTokenLayer.tokens.push(bare);
  assert.deepEqual(foreignAnnotationLossForWord(layerInfo, bare), { spans: 0, links: 0 });
});

test('sentence-level material does not count toward a word delete', () => {
  const { word, layerInfo } = make();
  const { spans } = foreignAnnotationLossForWord(layerInfo, word);
  assert.equal(spans, 2, 'the Translation span on the containing sentence is untouched');
});

test('handles missing layers / word gracefully', () => {
  assert.deepEqual(foreignAnnotationLossForWord(null, { id: 'x', begin: 0, end: 1 }),
    { spans: 0, links: 0 });
  assert.deepEqual(foreignAnnotationLossForWord({ textLayer: {} }, null),
    { spans: 0, links: 0 });
});
