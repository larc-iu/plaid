// What reconcile-on-open does with an unaligned node another app's edit to
// the sentences has moved.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeUmrReconcile, planUnalignedHeal } from '../src/domain/umrReconcile.js';

// Sentences as buildDocumentGraph gives them: by position, with their tokens.
const sentences = (...list) =>
  list.map(([tokenId, begin, end], i) => ({ index: i + 1, tokenId, begin, end }));
const unaligned = (id, at, sentence, home) => ({
  id,
  constant: false,
  aligned: false,
  pieces: [{ id: `p-${id}`, begin: at, end: at }],
  sentence,
  metadata: home ? { umr: { sentence: home } } : null,
});
const graphOf = (list, nodes) => ({
  sentences: list,
  nodesById: new Map(nodes.map((n) => [n.id, n])),
});

// Sentence B's text was deleted: its unaligned node kept its point, which is
// now the start of C, among C's own unaligned node.
test("a deleted sentence's unaligned node goes, and the next sentence's stays", () => {
  const graph = graphOf(sentences(['A', 0, 10], ['C', 10, 20]), [
    unaligned('b1', 10, 2, 'B'),
    unaligned('c1', 10, 2, 'C'),
  ]);
  assert.deepEqual(planUnalignedHeal(graph, 'umr'), { remove: ['b1'], rebind: [] });
});

// The last sentence deleted: its node is now past the end, in no sentence.
test('a node left in no sentence goes', () => {
  const graph = graphOf(sentences(['A', 0, 10]), [unaligned('z1', 10, null, 'Z')]);
  assert.deepEqual(planUnalignedHeal(graph, 'umr').remove, ['z1']);
});

// B merged into A: B's token is gone, but its node is inside A, not at a
// sentence start, and belongs to it.
test("a merged sentence's unaligned node is bound to the sentence it joined", () => {
  const graph = graphOf(sentences(['A', 0, 20]), [
    unaligned('a1', 0, 1, 'A'),
    unaligned('b1', 10, 1, 'B'),
  ]);
  assert.deepEqual(planUnalignedHeal(graph, 'umr'), {
    remove: [],
    rebind: [{ nodeId: 'b1', sentenceTokenId: 'A' }],
  });
});

test('an aligned node, a constant and a node with no record are left alone', () => {
  const graph = graphOf(sentences(['C', 10, 20]), [
    { ...unaligned('w', 12, 1, 'B'), aligned: true },
    { ...unaligned('k', 0, null, 'B'), constant: true },
    unaligned('old', 10, 1, null),
  ]);
  assert.deepEqual(planUnalignedHeal(graph, 'umr'), { remove: [], rebind: [] });
});

test('the audit label names what the pass changed', () => {
  assert.equal(describeUmrReconcile({}), null);
  assert.equal(
    describeUmrReconcile({ removed: 1, rebound: 2 }),
    'Reconcile: removed 1 unaligned node of a deleted sentence, rebound 2 unaligned nodes to a merged sentence',
  );
});
