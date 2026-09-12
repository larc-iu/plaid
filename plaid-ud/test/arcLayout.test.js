// Pure-fn tests for the dependency tree's arc stacking (arcLayout.js): which
// level each arc is drawn at, and how tall the tree that holds them has to be.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  computeArcLayout,
  buildIndexById,
  arcHeight,
  ARC_BASE,
  ARC_STEP,
} from '../src/components/editor/annotation/arcLayout.js';

// A sentence of `n` words, one lemma span per word, named w0..w(n-1) / s0..s(n-1).
const sentence = (n) => {
  const tokens = Array.from({ length: n }, (_, i) => ({ id: `w${i}` }));
  const lemmaSpans = tokens.map((t, i) => ({ id: `s${i}`, tokens: [t.id] }));
  return { tokens, lemmaSpans, indexById: buildIndexById(tokens, lemmaSpans) };
};

// `[head, dependent]` pairs, by column, as relations over those lemma spans.
const arcs = (pairs) =>
  pairs.map(([head, dep], i) => ({ id: `r${i}`, source: `s${head}`, target: `s${dep}` }));

const levelsOf = (n, pairs) => {
  const { indexById } = sentence(n);
  const { levels } = computeArcLayout(arcs(pairs), indexById);
  return pairs.map((_, i) => levels.get(`r${i}`));
};

test('an arc sits one level above the arc it encloses', () => {
  // 0 → 3 encloses 1 → 2.
  assert.deepEqual(levelsOf(4, [[1, 2]]), [1]);
  assert.deepEqual(
    levelsOf(4, [
      [1, 2],
      [0, 3],
    ]),
    [1, 2],
  );
});

test('the order the relations arrive in does not change the stack', () => {
  assert.deepEqual(
    levelsOf(4, [
      [0, 3],
      [1, 2],
    ]),
    [2, 1],
  );
});

test('arcs standing side by side share a level', () => {
  // Two arcs meeting at word 2 are still side by side: nothing is between them.
  assert.deepEqual(
    levelsOf(5, [
      [0, 2],
      [2, 4],
    ]),
    [1, 1],
  );
  // Wholly separate arcs, likewise.
  assert.deepEqual(
    levelsOf(5, [
      [0, 1],
      [3, 4],
    ]),
    [1, 1],
  );
});

test('arcs that cross are stacked, narrower one below', () => {
  // 0 → 5 and 2 → 8 overlap without either enclosing the other: a
  // non-projective pair still crosses on screen, but not at the same height.
  const [a, b] = levelsOf(9, [
    [0, 5],
    [2, 8],
  ]);
  assert.notEqual(a, b);
});

test('several arcs out of one head climb one level at a time', () => {
  // A head with three dependents to its right: each arc encloses the last.
  assert.deepEqual(
    levelsOf(5, [
      [0, 1],
      [0, 2],
      [0, 3],
    ]),
    [1, 2, 3],
  );
});

test('no two arcs sharing a word are drawn at the same height', () => {
  // A projective tree over ten words, built as nested phrases.
  const pairs = [
    [1, 0], // nsubj
    [1, 5], // obl, over the whole phrase
    [5, 2],
    [5, 3],
    [5, 4],
    [1, 9],
    [9, 6],
    [9, 7],
    [9, 8],
  ];
  const { indexById } = sentence(10);
  const { levels } = computeArcLayout(arcs(pairs), indexById);
  const drawn = pairs.map(([h, d], i) => ({
    left: Math.min(h, d),
    right: Math.max(h, d),
    level: levels.get(`r${i}`),
  }));

  for (const a of drawn) {
    for (const b of drawn) {
      if (a === b) continue;
      const sharesAWord = Math.max(a.left, b.left) < Math.min(a.right, b.right);
      if (sharesAWord) assert.notEqual(a.level, b.level);
      // And what encloses is drawn above what it encloses.
      if (a.left <= b.left && a.right >= b.right && (a.left < b.left || a.right > b.right)) {
        assert.ok(a.level > b.level);
      }
    }
  }
});

test('a root relation takes no room in the stack', () => {
  const { indexById } = sentence(3);
  const root = { id: 'root', source: 's1', target: 's1' };
  const { levels, maxLevel } = computeArcLayout([root, ...arcs([[1, 0]])], indexById);
  assert.equal(levels.has('root'), false);
  assert.equal(maxLevel, 1);
});

test('a relation whose endpoints are not on screen is left out', () => {
  const { indexById } = sentence(3);
  const stale = { id: 'stale', source: 'sX', target: 's0' };
  const { levels, maxLevel } = computeArcLayout([stale], indexById);
  assert.equal(levels.has('stale'), false);
  assert.equal(maxLevel, 0);
});

test('a token stands in for its own lemma span, and a multi-word span for its first word', () => {
  const tokens = [{ id: 'w0' }, { id: 'w1' }, { id: 'w2' }];
  const lemmaSpans = [
    { id: 's01', tokens: ['w0', 'w1'] },
    { id: 's2', tokens: ['w2'] },
  ];
  const indexById = buildIndexById(tokens, lemmaSpans);
  assert.equal(indexById.get('s01'), 0);
  assert.equal(indexById.get('w1'), 1);
  assert.equal(indexById.get('s2'), 2);
});

test('the tree is as tall as its deepest stack, and the grid reserves the same', () => {
  const { indexById } = sentence(8);
  const shallow = computeArcLayout(
    arcs([
      [0, 1],
      [0, 2],
      [0, 3],
    ]),
    indexById,
  );
  const deep = computeArcLayout(
    arcs([
      [0, 1],
      [0, 2],
      [0, 3],
      [0, 4],
      [0, 5],
      [0, 6],
      [0, 7],
    ]),
    indexById,
  );
  assert.equal(deep.treeHeight - shallow.treeHeight, arcHeight(7) - arcHeight(3));
  assert.equal(deep.gridPaddingTop, deep.treeHeight - 85);

  // However few arcs a sentence has, there is still a tree to draw into: a
  // floor keeps the ROOT bar a draggable distance above the words.
  assert.equal(computeArcLayout([], indexById).treeHeight, 150);
  assert.equal(computeArcLayout(arcs([[0, 1]]), indexById).treeHeight, 150);
});

test('each level adds a fixed step', () => {
  assert.equal(arcHeight(1), ARC_BASE);
  assert.equal(arcHeight(3), ARC_BASE + 2 * ARC_STEP);
});
