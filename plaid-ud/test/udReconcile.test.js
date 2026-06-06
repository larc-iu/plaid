// Reconcile-on-open: which dependency relations cross a sentence boundary.
// Uses Node's built-in test runner — run `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { interSententialRelationIds } from '../src/utils/udReconcile.js';

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
