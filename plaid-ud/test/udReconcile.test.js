// Which relations a sentence split takes off
// the screen (the server's same-ancestor rule deletes them).
// Uses Node's built-in test runner — run `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { relationsCrossing } from '../src/utils/udReconcile.js';

// Two sentences [0,10) and [10,20). Three lemma spans, one per morpheme, whose
// begin offsets place them: ls1,ls2 in sentence 1; ls3 in sentence 2.
const layerInfo = {
  sentenceTokenLayer: {
    tokens: [
      { id: 's1', begin: 0, end: 10 },
      { id: 's2', begin: 10, end: 20 },
    ],
  },
  morphemeTokenLayer: {
    tokens: [
      { id: 'm1', begin: 0, end: 0 },
      { id: 'm2', begin: 5, end: 5 },
      { id: 'm3', begin: 12, end: 12 },
    ],
  },
  lemmaLayer: {
    spans: [
      { id: 'ls1', tokens: ['m1'] },
      { id: 'ls2', tokens: ['m2'] },
      { id: 'ls3', tokens: ['m3'] },
    ],
  },
  relationLayer: {
    relations: [
      { id: 'r1', source: 'ls1', target: 'ls2' }, // same sentence -> kept
      { id: 'r2', source: 'ls1', target: 'ls3' }, // s1 -> s2 -> crosses
      { id: 'r3', source: 'ls1', target: 'ls1' }, // root self-loop -> ignored
      { id: 'r4', source: 'ls1', target: 'unknown' }, // unresolvable -> left alone
    ],
  },
};

// --- relationsCrossing (the same rule, asked of a boundary not yet made) ---

// The one sentence [0,20) about to be split at 10. ls1,ls2 are left of it and
// ls3 is right of it, so r2 is the relation the split cuts.
const beforeSplit = {
  ...layerInfo,
  sentenceTokenLayer: { tokens: [{ id: 's1', begin: 0, end: 20 }] },
};

test('flags the relations a boundary here would split', () => {
  assert.deepEqual(relationsCrossing(beforeSplit, 10), ['r2']);
});

test('a boundary no relation reaches over splits nothing', () => {
  // Past every endpoint: nothing has an end on the far side.
  assert.deepEqual(relationsCrossing(beforeSplit, 19), []);
  // Before every endpoint, likewise.
  assert.deepEqual(relationsCrossing(beforeSplit, 0), []);
});

test('root self-loops and unresolvable endpoints are left alone', () => {
  const only = {
    ...beforeSplit,
    relationLayer: {
      relations: [
        { id: 'r3', source: 'ls1', target: 'ls1' },
        { id: 'r4', source: 'ls1', target: 'unknown' },
      ],
    },
  };
  assert.deepEqual(relationsCrossing(only, 10), []);
});

test('relationsCrossing on a document with nothing in it', () => {
  assert.deepEqual(relationsCrossing(null, 10), []);
  assert.deepEqual(relationsCrossing({ ...beforeSplit, relationLayer: { relations: [] } }, 10), []);
});
