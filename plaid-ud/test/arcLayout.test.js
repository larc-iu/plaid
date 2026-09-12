// Pure-fn tests for the dependency tree's arc stacking (arcLayout.js): which
// level each arc is drawn at, and how tall the tree that holds them has to be.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  computeArcLayout,
  buildIndexById,
  assignLevels,
  arcHeight,
  arcPath,
  ARC_BASE,
  ARC_STEP,
  ARC_CORNER,
} from '../src/utils/arcLayout.js';

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

test('a tree drawn at another scale passes its own base and step', () => {
  // The citation card's stack compresses to fit a panel. Only the size
  // changes: the order the levels come in is the same.
  assert.equal(arcHeight(3, { base: 10, step: 5 }), 20);
  assert.ok(arcHeight(2, { base: 10, step: 5 }) < arcHeight(3, { base: 10, step: 5 }));
});

test('levels can be assigned over plain intervals, whatever drew them', () => {
  // The card works in word columns and has no relation ids, so it stacks
  // through this rather than through computeArcLayout.
  const { levels, maxLevel } = assignLevels([
    { id: 'wide', left: 0, right: 4 },
    { id: 'inner', left: 1, right: 2 },
    { id: 'beside', left: 4, right: 5 },
  ]);
  assert.equal(levels.get('inner'), 1);
  assert.equal(levels.get('wide'), 2);
  assert.equal(levels.get('beside'), 1);
  assert.equal(maxLevel, 2);
});

// The turn out of the rise, read back off a path: where the first curve ends.
const turnWidth = (d, fromX) => Math.abs(Number(d.match(/Q [-\d.]+ [-\d.]+ ([-\d.]+)/)[1]) - fromX);

test('an arc runs flat at its own height', () => {
  const d = arcPath(100, 300, 200, 50);
  const run = [...d.matchAll(/Q [-\d.]+ ([-\d.]+)/g)].map((m) => Number(m[1]));
  assert.deepEqual(run, [150, 150]); // baseline 200, height 50, both turns level
  assert.ok(d.startsWith('M 100 200'));
  assert.ok(d.endsWith('300 200'));
});

test('every arc turns through the same width, which is what stops them crossing', () => {
  // A wide arc that turned more gently than the narrow one nested under it
  // would climb more slowly and cut through it near their shared endpoint.
  assert.equal(turnWidth(arcPath(0, 200, 100, 30), 0), ARC_CORNER);
  assert.equal(turnWidth(arcPath(0, 2000, 100, 90), 0), ARC_CORNER);
  // Leftward, likewise.
  assert.equal(turnWidth(arcPath(2000, 0, 100, 90), 2000), ARC_CORNER);
});

test('an arc narrower than two turns meets in the middle', () => {
  assert.equal(turnWidth(arcPath(0, 20, 100, 30), 0), 10);
});
