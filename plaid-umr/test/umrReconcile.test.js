// What reconcile-on-open does with an unaligned node another app's edit to
// the sentences has moved.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeUmrReconcile, planUnalignedHeal } from '../src/domain/umrReconcile.js';

// Sentences as buildDocumentGraph gives them: by position, with their tokens
// and their nodes (filled in by graphOf).
const sentences = (...list) =>
  list.map(([tokenId, begin, end], i) => ({ index: i + 1, tokenId, begin, end, nodes: [] }));
const node = (id, { at, sentence, home = null, aligned = false }) => ({
  id,
  constant: false,
  aligned,
  pieces: [{ id: `p-${id}`, begin: at, end: aligned ? at + 1 : at }],
  sentence,
  metadata: home ? { umr: { sentence: home } } : null,
  in: [],
  out: [],
});
const unaligned = (id, at, sentence, home) => node(id, { at, sentence, home });
const anchored = (id, at, sentence) => node(id, { at, sentence, aligned: true });
// An edge of the sentence graph, from `a` to `b`.
const edge = (a, b) => {
  const e = { id: `${a.id}-${b.id}`, source: a.id, target: b.id };
  a.out.push(e);
  b.in.push(e);
};
const graphOf = (list, nodes) => {
  nodes.forEach((n) => n.sentence && list[n.sentence - 1].nodes.push(n));
  return { sentences: list, nodesById: new Map(nodes.map((n) => [n.id, n])) };
};
const plan = (graph) => planUnalignedHeal(graph, 'umr');

// Sentence B's text was deleted: its unaligned node kept its point, which is
// now the start of C, among C's own graph. Its aligned neighbours went with
// B's words.
test("a deleted sentence's unaligned node goes, and the next sentence's stays", () => {
  const c1 = unaligned('c1', 10, 2, 'C');
  const ce = anchored('ce', 12, 2);
  edge(ce, c1);
  const graph = graphOf(sentences(['A', 0, 10], ['C', 10, 20]), [
    unaligned('b1', 10, 2, 'B'),
    c1,
    ce,
  ]);
  assert.deepEqual(plan(graph), { remove: ['b1'], rebind: [], move: [] });
});

// The one sentence with unaligned nodes deleted: no record anywhere names a
// live sentence, which is no reason to keep a stray among C's own graph.
test('a stray goes even when no record left names a live sentence', () => {
  const b1 = unaligned('b1', 10, 2, 'B');
  const b2 = unaligned('b2', 10, 2, 'B');
  edge(b1, b2);
  const graph = graphOf(sentences(['A', 0, 10], ['C', 10, 20]), [b1, b2, anchored('ce', 12, 2)]);
  assert.deepEqual(plan(graph).remove, ['b1', 'b2']);
});

// The last sentence deleted: its node is now past the end, in no sentence.
test('a node left in no sentence goes', () => {
  const graph = graphOf(sentences(['A', 0, 10]), [
    unaligned('a1', 0, 1, 'A'),
    unaligned('z1', 10, null, 'Z'),
  ]);
  assert.deepEqual(plan(graph).remove, ['z1']);
});

// B merged into A: B's token is gone, but its node is joined to B's words,
// which are in A now.
test("a merged sentence's unaligned node is bound to the sentence it joined", () => {
  const b1 = unaligned('b1', 10, 1, 'B');
  const be = anchored('be', 12, 1);
  edge(be, b1);
  const graph = graphOf(sentences(['A', 0, 20]), [unaligned('a1', 0, 1, 'A'), b1, be]);
  assert.deepEqual(plan(graph), {
    remove: [],
    rebind: [{ nodeId: 'b1', sentenceTokenId: 'A' }],
    move: [],
  });
});

// A boundary taken away and put back: the sentence is where it was, under a
// new token C, and its node at C's start is joined to C's words. The old
// rule took it for a deleted sentence's stray, since it sits at a start.
test('a boundary removed and put back keeps the sentence its node', () => {
  const b1 = unaligned('b1', 10, 2, 'B');
  const be = anchored('be', 12, 2);
  edge(be, b1);
  const graph = graphOf(sentences(['A', 0, 10], ['C', 10, 20]), [
    unaligned('a1', 0, 1, 'A'),
    b1,
    be,
  ]);
  assert.deepEqual(plan(graph), {
    remove: [],
    rebind: [{ nodeId: 'b1', sentenceTokenId: 'C' }],
    move: [],
  });
});

// The same, for a graph made in text mode and never anchored: every node of
// the sentence records the old token, so they are that sentence's graph,
// fragments and all.
test('an unanchored graph that is all its sentence has is bound to it', () => {
  const b1 = unaligned('b1', 10, 2, 'B');
  const b2 = unaligned('b2', 10, 2, 'B');
  edge(b1, b2);
  const graph = graphOf(sentences(['A', 0, 10], ['C', 10, 20]), [
    b1,
    b2,
    unaligned('b3', 10, 2, 'B'),
  ]);
  assert.deepEqual(
    plan(graph).rebind.map((r) => r.nodeId),
    ['b1', 'b2', 'b3'],
  );
  assert.deepEqual(plan(graph).remove, []);
});

// A copy or an import that gave the rows new ids and kept the old records:
// every node is still joined to its own sentence's words, so all are bound
// and none removed.
test('records naming sentences of another document rebind, and remove nothing', () => {
  const a1 = unaligned('a1', 0, 1, 'A');
  const ae = anchored('ae', 2, 1);
  const b1 = unaligned('b1', 10, 2, 'B');
  const be = anchored('be', 12, 2);
  edge(ae, a1);
  edge(be, b1);
  const graph = graphOf(sentences(['A2', 0, 10], ['B2', 10, 20]), [a1, ae, b1, be]);
  assert.deepEqual(plan(graph), {
    remove: [],
    rebind: [
      { nodeId: 'a1', sentenceTokenId: 'A2' },
      { nodeId: 'b1', sentenceTokenId: 'B2' },
    ],
    move: [],
  });
});

// Text typed at the start of B goes to A, and B's node, left where it was, is
// inside A now. Its record names B, alive: it goes back to B's start.
test('a node an insert left in the sentence before goes back to its own', () => {
  const graph = graphOf(sentences(['A', 0, 15], ['B', 15, 25]), [unaligned('b1', 10, 1, 'B')]);
  assert.deepEqual(plan(graph), {
    remove: [],
    rebind: [],
    move: [{ nodeId: 'b1', pieceId: 'p-b1', to: 15 }],
  });
});

test('an aligned node, a constant and a node with no record are left alone', () => {
  const graph = graphOf(sentences(['C', 10, 20]), [
    { ...anchored('w', 12, 1), metadata: { umr: { sentence: 'B' } } },
    { ...unaligned('k', 0, null, 'B'), constant: true },
    unaligned('old', 10, 1, null),
  ]);
  assert.deepEqual(plan(graph), { remove: [], rebind: [], move: [] });
});

test('the audit label names what the pass changed', () => {
  assert.equal(describeUmrReconcile({}), null);
  assert.equal(
    describeUmrReconcile({ removed: 1, rebound: 2, moved: 1 }),
    'Reconcile: removed 1 unaligned node of a deleted sentence, rebound 2 unaligned nodes to the sentence they are in, moved 1 unaligned node back to the start of its sentence',
  );
});
