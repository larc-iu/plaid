// Astral-text coverage for the tokenizer. Offsets are Unicode CODE POINTS.
// 😀 = U+1F600: one code point, two UTF-16 units — so "cat" in "😀 cat" is
// code-point [2,5] (it would be UTF-16 [3,6]). Uses Node's built-in test
// runner — run with `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { basicTokenize, newlineSentenceRanges } from '../src/utils/basicTokenize.js';

test('basicTokenize emits code-point ranges across an astral char', () => {
  assert.deepEqual(basicTokenize('😀 cat'), [
    [0, 1],
    [2, 5],
  ]);
});

test('basicTokenize is unaffected for BMP text', () => {
  assert.deepEqual(basicTokenize('the cat'), [
    [0, 3],
    [4, 7],
  ]);
});

test('a word after an astral char gets a code-point offset', () => {
  // "𐌰 dog": Gothic 𐌰 (SMP) is one code point -> "dog" is [2,5], not UTF-16 [3,6]
  assert.deepEqual(basicTokenize('𐌰 dog'), [
    [0, 1],
    [2, 5],
  ]);
});

// The sentence partition the Tokenize button makes. It has to TILE the body:
// the sentence layer is partitioning, so a gap in it is a 400, and a newline
// run therefore ends the sentence it follows rather than sitting between two.
test('newlineSentenceRanges tiles the body, keeping each newline run with the sentence before it', () => {
  assert.deepEqual(newlineSentenceRanges('one\ntwo'), [
    [0, 4],
    [4, 7],
  ]);
  assert.deepEqual(newlineSentenceRanges('one\n\n\ntwo'), [
    [0, 6],
    [6, 9],
  ]);
});

test('newlineSentenceRanges makes one sentence of a body with no newline, and of an empty one', () => {
  assert.deepEqual(newlineSentenceRanges('the cat'), [[0, 7]]);
  assert.deepEqual(newlineSentenceRanges(''), [[0, 0]]);
});

test('a trailing newline leaves no empty sentence after it', () => {
  assert.deepEqual(newlineSentenceRanges('one\n'), [[0, 4]]);
  assert.deepEqual(newlineSentenceRanges('\n'), [[0, 1]]);
});

test('newlineSentenceRanges counts code points, not UTF-16 units', () => {
  // 😀 is one code point and two UTF-16 units, so the boundary after the
  // newline is at 3, not 4.
  assert.deepEqual(newlineSentenceRanges('😀😀\n😀'), [
    [0, 3],
    [3, 4],
  ]);
});
