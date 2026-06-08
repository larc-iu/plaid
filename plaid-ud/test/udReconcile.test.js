// Reconcile-on-open: which dependency relations cross a sentence boundary.
// Uses Node's built-in test runner — run `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { interSententialRelationIds, wordsNeedingSyntacticWord } from '../src/utils/udReconcile.js';

// Two sentences [0,10) and [10,20). Three lemma spans, one per morpheme, whose
// begin offsets place them: ls1,ls2 in sentence 1; ls3 in sentence 2.
const layerInfo = {
  sentenceTokenLayer: { tokens: [
    { id: 's1', begin: 0, end: 10 },
    { id: 's2', begin: 10, end: 20 },
  ] },
  morphemeTokenLayer: { tokens: [
    { id: 'm1', begin: 0, end: 0 },
    { id: 'm2', begin: 5, end: 5 },
    { id: 'm3', begin: 12, end: 12 },
  ] },
  lemmaLayer: { spans: [
    { id: 'ls1', tokens: ['m1'] },
    { id: 'ls2', tokens: ['m2'] },
    { id: 'ls3', tokens: ['m3'] },
  ] },
  relationLayer: { relations: [
    { id: 'r1', source: 'ls1', target: 'ls2' }, // same sentence -> kept
    { id: 'r2', source: 'ls1', target: 'ls3' }, // s1 -> s2 -> crosses
    { id: 'r3', source: 'ls1', target: 'ls1' }, // root self-loop -> ignored
    { id: 'r4', source: 'ls1', target: 'unknown' }, // unresolvable -> left alone
  ] },
};

test('flags only relations whose endpoints are in different sentences', () => {
  assert.deepEqual(interSententialRelationIds(layerInfo), ['r2']);
});

test('returns [] when there are no relations or no sentences', () => {
  assert.deepEqual(interSententialRelationIds({ ...layerInfo, relationLayer: { relations: [] } }), []);
  assert.deepEqual(interSententialRelationIds({ ...layerInfo, sentenceTokenLayer: { tokens: [] } }), []);
  assert.deepEqual(interSententialRelationIds(null), []);
});

test('ignores root self-loops and same-sentence relations', () => {
  const onlySafe = {
    ...layerInfo,
    relationLayer: { relations: [
      { id: 'r1', source: 'ls1', target: 'ls2' },
      { id: 'r3', source: 'ls1', target: 'ls1' },
    ] },
  };
  assert.deepEqual(interSententialRelationIds(onlySafe), []);
});

// --- wordsNeedingSyntacticWord (symmetric heal: seed UD syntactic-words) ---

test('flags words with no full-width syntactic-word covering their extent', () => {
  const info = {
    wordTokenLayer: { tokens: [
      { id: 'w1', begin: 0, end: 5 },   // covered
      { id: 'w2', begin: 6, end: 9 },   // bare -> needs one
      { id: 'w3', begin: 10, end: 14 }, // bare -> needs one
    ] },
    morphemeTokenLayer: { tokens: [
      { id: 'm1', begin: 0, end: 5 },       // covers w1
      { id: 'm2', begin: 99, end: 100 },    // unrelated extent
    ] },
  };
  assert.deepEqual(wordsNeedingSyntacticWord(info), [
    { begin: 6, end: 9 },
    { begin: 10, end: 14 },
  ]);
});

test('an MWT word (multiple full-width syntactic-words) counts as covered', () => {
  const info = {
    wordTokenLayer: { tokens: [{ id: 'w1', begin: 0, end: 3 }] },
    morphemeTokenLayer: { tokens: [
      { id: 'm1', begin: 0, end: 3, precedence: 0 },
      { id: 'm2', begin: 0, end: 3, precedence: 1 },
    ] },
  };
  assert.deepEqual(wordsNeedingSyntacticWord(info), []);
});

test('returns [] when there are no words; all bare when no syntactic-words', () => {
  assert.deepEqual(wordsNeedingSyntacticWord({ wordTokenLayer: { tokens: [] } }), []);
  assert.deepEqual(wordsNeedingSyntacticWord(null), []);
  const allBare = {
    wordTokenLayer: { tokens: [{ id: 'w1', begin: 0, end: 4 }, { id: 'w2', begin: 5, end: 8 }] },
    morphemeTokenLayer: { tokens: [] },
  };
  assert.deepEqual(wordsNeedingSyntacticWord(allBare), [
    { begin: 0, end: 4 },
    { begin: 5, end: 8 },
  ]);
});
