// What reconcile-on-open does with a node aligned to no word, after another
// app's edit to the sentences it stands in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeUmrReconcile, planUnalignedHeal } from '../src/domain/umrReconcile.js';

// Sentences as buildDocumentGraph gives them: by position, with their tokens
// and their nodes (filled in by graphOf).
const sentences = (...list) =>
  list.map(([tokenId, begin, end], i) => ({ index: i + 1, tokenId, begin, end, nodes: [] }));
// A node aligned to no word: it records its sentence, and its anchor covers
// the stretch of text given, which is its sentence's extent once reconcile
// has run.
const unaligned = (id, [begin, end], sentence, home) => ({
  id,
  constant: false,
  aligned: false,
  pieces: [{ id: `p-${id}`, begin, end }],
  sentence,
  metadata: home ? { umr: { sentence: home } } : null,
  in: [],
  out: [],
});
const anchored = (id, at, sentence) => ({
  id,
  constant: false,
  aligned: true,
  pieces: [{ id: `p-${id}`, begin: at, end: at + 1 }],
  sentence,
  metadata: null,
  in: [],
  out: [],
});
const graphOf = (list, nodes) => {
  nodes.forEach((n) => n.sentence && list[n.sentence - 1].nodes.push(n));
  return { sentences: list, nodesById: new Map(nodes.map((n) => [n.id, n])) };
};
const plan = (graph) => planUnalignedHeal(graph, 'umr');
const nothing = { remove: [], rebind: [], resize: [] };

test('a node standing over the sentence it records is left alone', () => {
  const graph = graphOf(sentences(['A', 0, 10], ['B', 10, 20]), [
    unaligned('a1', [0, 10], 1, 'A'),
    unaligned('b1', [10, 20], 2, 'B'),
    anchored('be', 12, 2),
  ]);
  assert.deepEqual(plan(graph), nothing);
});

// The old shape: a point at the sentence's start. The first open of an older
// document puts every one of them over its sentence.
test('a node anchored to a point is put back over its sentence', () => {
  const graph = graphOf(sentences(['A', 0, 10], ['B', 10, 20]), [
    unaligned('b1', [10, 10], 2, 'B'),
  ]);
  assert.deepEqual(plan(graph), {
    remove: [],
    rebind: [],
    resize: [{ nodeId: 'b1', pieceId: 'p-b1', begin: 10, end: 20 }],
  });
});

// Text typed at the start of B: the sentence grew, so the anchor is grown
// with it.
test('an anchor that no longer covers its sentence is put back over it', () => {
  const graph = graphOf(sentences(['A', 0, 15], ['B', 15, 30]), [
    unaligned('b1', [18, 25], 2, 'B'),
  ]);
  assert.deepEqual(plan(graph).resize, [{ nodeId: 'b1', pieceId: 'p-b1', begin: 15, end: 30 }]);
});

// B joined to A: the merged sentence keeps A's token, so B's record names a
// token that is gone. Its words are in A now, and so is it.
test("a joined sentence's node is bound to the sentence it joined", () => {
  const b1 = unaligned('b1', [10, 20], 1, 'B');
  const b2 = unaligned('b2', [10, 20], 1, 'B');
  const graph = graphOf(sentences(['A', 0, 20]), [anchored('ae', 2, 1), b1, b2]);
  assert.deepEqual(plan(graph), {
    remove: [],
    rebind: [
      { nodeId: 'b1', sentenceTokenId: 'A' },
      { nodeId: 'b2', sentenceTokenId: 'A' },
    ],
    resize: [
      { nodeId: 'b1', pieceId: 'p-b1', begin: 0, end: 20 },
      { nodeId: 'b2', pieceId: 'p-b2', begin: 0, end: 20 },
    ],
  });
});

// A boundary taken away and put back: the sentence is where it was, under a
// new token C.
test('a boundary removed and put back keeps the sentence its nodes', () => {
  const graph = graphOf(sentences(['A', 0, 10], ['C', 10, 20]), [
    unaligned('a1', [0, 10], 1, 'A'),
    unaligned('b1', [10, 20], 2, 'B'),
  ]);
  assert.deepEqual(plan(graph), {
    remove: [],
    rebind: [{ nodeId: 'b1', sentenceTokenId: 'C' }],
    resize: [],
  });
});

// A copy or an import that gave the rows new ids and kept the old records.
test('records naming sentences of another document rebind, and remove nothing', () => {
  const graph = graphOf(sentences(['A2', 0, 10], ['B2', 10, 20]), [
    unaligned('a1', [0, 10], 1, 'A'),
    unaligned('b1', [10, 20], 2, 'B'),
  ]);
  assert.deepEqual(plan(graph), {
    remove: [],
    rebind: [
      { nodeId: 'a1', sentenceTokenId: 'A2' },
      { nodeId: 'b1', sentenceTokenId: 'B2' },
    ],
    resize: [],
  });
});

// The last sentence's text deleted: core takes the anchor with the text it
// covers, so the node is gone before reconcile sees it. One left outside
// every sentence has no sentence to belong to and shows nowhere.
test('a node left outside every sentence goes', () => {
  const graph = graphOf(sentences(['A', 0, 10]), [
    unaligned('a1', [0, 10], 1, 'A'),
    unaligned('z1', [10, 10], null, 'Z'),
  ]);
  assert.deepEqual(plan(graph).remove, ['z1']);
  assert.deepEqual(plan(graph).rebind, []);
});

test('an aligned node, a constant and a node with no record are left alone', () => {
  const graph = graphOf(sentences(['C', 10, 20]), [
    anchored('w', 12, 1),
    { ...unaligned('k', [0, 0], null, 'B'), constant: true },
    unaligned('old', [10, 10], 1, null),
  ]);
  assert.deepEqual(plan(graph), nothing);
});

test('the audit label names what the pass changed', () => {
  assert.equal(describeUmrReconcile({}), null);
  assert.equal(
    describeUmrReconcile({ removed: 1, rebound: 2, resized: 1 }),
    'Reconcile: removed 1 unaligned node left outside every sentence, rebound 2 unaligned nodes to the sentence they are in, put 1 unaligned node back over its sentence',
  );
});
