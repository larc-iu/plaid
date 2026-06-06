/**
 * Tests for the Unicode code-point helpers (text offsets are code-point
 * indices, not UTF-16). Uses Node's built-in test runner — run with `npm test`.
 *
 * Fixture note: 😀 (U+1F600) is ONE code point but TWO UTF-16 units, so in
 * "😀 cat" the substring "cat" is code-point [2,5] but UTF-16 [3,6].
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { cpLength, cpSlice, utf16ToCp, cpToUtf16, cpIndexOf } from '../src/codepoint.js';

test('cpLength counts code points, not UTF-16 units', () => {
  assert.equal(cpLength(''), 0);
  assert.equal(cpLength('cat'), 3);
  assert.equal(cpLength('😀'), 1); // .length would be 2
  assert.equal(cpLength('😀 cat'), 5); // .length would be 6
  assert.equal(cpLength('𐌰𐌱𐌲'), 3); // Gothic, all SMP
});

test('cpSlice slices by code points', () => {
  assert.equal(cpSlice('😀 cat', 2, 5), 'cat');
  assert.equal(cpSlice('😀 cat', 0, 1), '😀'); // whole emoji, not a half surrogate
  assert.equal(cpSlice('😀 cat', 2), 'cat'); // open-ended
  assert.equal(cpSlice('😀 cat', 2, 2), ''); // zero-width
  assert.equal(cpSlice('𐌰𐌱𐌲', 1, 2), '𐌱');
  assert.equal(cpSlice('abc', 1, 2), 'b'); // BMP unchanged
});

test('utf16ToCp / cpToUtf16 are inverses and convert correctly', () => {
  const s = '😀 cat';
  // code point -> UTF-16: cp2 ("c") is at UTF-16 index 3 (emoji occupies 0..1)
  assert.equal(cpToUtf16(s, 2), 3);
  assert.equal(cpToUtf16(s, 0), 0);
  assert.equal(cpToUtf16(s, 5), s.length); // end clamps
  assert.equal(cpToUtf16(s, 99), s.length); // past end clamps
  // UTF-16 -> code point
  assert.equal(utf16ToCp(s, 3), 2);
  assert.equal(utf16ToCp(s, 0), 0);
  assert.equal(utf16ToCp(s, s.length), 5);
  // round-trip for every code-point index
  for (let cp = 0; cp <= cpLength(s); cp++) {
    assert.equal(utf16ToCp(s, cpToUtf16(s, cp)), cp);
  }
});

test('cpIndexOf returns a code-point index', () => {
  assert.equal(cpIndexOf('😀 cat', 'cat'), 2); // UTF-16 indexOf would be 3
  assert.equal(cpIndexOf('a😀b', 'b'), 2); // UTF-16 indexOf would be 3
  assert.equal(cpIndexOf('😀 cat', 'dog'), -1);
  assert.equal(cpIndexOf('😀a😀a', 'a', 2), 3); // fromCp skips the first 'a'
  assert.equal(cpIndexOf('abc', 'b'), 1); // BMP unchanged
});
