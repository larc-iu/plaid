import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupResults, segmentize } from '../src/components/search/grewToHighlight.js';

const S = 'SENT', N = 'MORPH';
// sentence "the dog runs" at doc offset 100, words the[100,103) dog[104,107) runs[108,112)
const sent = { id: 's1', layer: S, document: 'd1', begin: 100, end: 112, value: 'the dog runs' };
const dog = { id: 't_dog', layer: N, begin: 104, end: 107, value: 'dog' };
const runs = { id: 't_runs', layer: N, begin: 108, end: 112, value: 'runs' };

test('groups rows by sentence and computes relative highlight offsets', () => {
  const groups = groupResults([[sent, dog]], S, N);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].docId, 'd1');
  assert.equal(groups[0].sentenceId, 's1');
  assert.deepEqual(groups[0].highlights, [{ start: 4, end: 7 }]); // "dog"
});

test('merges multiple matches in the same sentence', () => {
  const groups = groupResults([[sent, dog], [sent, runs]], S, N);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].highlights, [{ start: 4, end: 7 }, { start: 8, end: 12 }]);
});

test('ignores non-node, non-sentence cells (e.g. relation entities)', () => {
  const rel = { id: 'r1', layer: 'REL' };
  const groups = groupResults([[sent, dog, rel]], S, N);
  assert.deepEqual(groups[0].highlights, [{ start: 4, end: 7 }]);
});

test('segmentize splits text into plain/highlighted runs', () => {
  const segs = segmentize('the dog runs', [{ start: 4, end: 7 }]);
  assert.deepEqual(segs, [
    { text: 'the ', hl: false },
    { text: 'dog', hl: true },
    { text: ' runs', hl: false },
  ]);
});

test('segmentize handles code points (astral chars) correctly', () => {
  // "a😀b" — the emoji is 1 code point but 2 UTF-16 units.
  const segs = segmentize('a😀b', [{ start: 1, end: 2 }]);
  assert.deepEqual(segs, [{ text: 'a', hl: false }, { text: '😀', hl: true }, { text: 'b', hl: false }]);
});

test('no highlights -> single plain segment', () => {
  assert.deepEqual(segmentize('hello', []), [{ text: 'hello', hl: false }]);
});
