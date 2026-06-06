// Astral-text coverage for the tokenizer. Offsets are Unicode CODE POINTS.
// 😀 = U+1F600: one code point, two UTF-16 units — so "cat" in "😀 cat" is
// code-point [2,5] (it would be UTF-16 [3,6]). Uses Node's built-in test
// runner — run with `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { basicTokenize } from '../src/utils/basicTokenize.js';

test('basicTokenize emits code-point ranges across an astral char', () => {
  assert.deepEqual(basicTokenize('😀 cat'), [[0, 1], [2, 5]]);
});

test('basicTokenize is unaffected for BMP text', () => {
  assert.deepEqual(basicTokenize('the cat'), [[0, 3], [4, 7]]);
});

test('a word after an astral char gets a code-point offset', () => {
  // "𐌰 dog": Gothic 𐌰 (SMP) is one code point -> "dog" is [2,5], not UTF-16 [3,6]
  assert.deepEqual(basicTokenize('𐌰 dog'), [[0, 1], [2, 5]]);
});
