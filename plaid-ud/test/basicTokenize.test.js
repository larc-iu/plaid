// Astral-text coverage for the tokenizer. Offsets are Unicode CODE POINTS.
// 😀 = U+1F600: one code point, two UTF-16 units — so "cat" in "😀 cat" is
// code-point [2,5] (it would be UTF-16 [3,6]). Uses Node's built-in test
// runner — run with `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { basicTokenize, gapTokenize, newlineSentenceRanges } from '../src/utils/basicTokenize.js';

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

test('a run of CRLF line breaks is one break, and no sentence holds only a line break (CR1)', () => {
  assert.deepEqual(newlineSentenceRanges('one two\r\n\r\nthree four'), [
    [0, 11],
    [11, 21],
  ]);
  assert.deepEqual(newlineSentenceRanges('one\r\ntwo'), [
    [0, 5],
    [5, 8],
  ]);
  assert.deepEqual(newlineSentenceRanges('😀 one\r\n\r\n\r\ntwo'), [
    [0, 11],
    [11, 14],
  ]);
});

test('gapTokenize tokenizes only what no token covers, inside each sentence', () => {
  const text = 'Tu viens ?\nOui !';
  const sentences = [
    [0, 11],
    [11, 16],
  ];
  const tokens = [
    { begin: 0, end: 2 },
    { begin: 3, end: 8 },
    { begin: 11, end: 14 },
  ];
  assert.deepEqual(gapTokenize(text, sentences, tokens), [
    [9, 10],
    [15, 16],
  ]);
  assert.deepEqual(gapTokenize(text, sentences, []), [
    [0, 2],
    [3, 8],
    [9, 10],
    [11, 14],
    [15, 16],
  ]);
  // Code points: an astral character counts once.
  assert.deepEqual(gapTokenize('😀 a .', [[0, 5]], [{ begin: 2, end: 3 }]), [
    [0, 1],
    [4, 5],
  ]);
});

test('a gap fill builds no segmenter per gap, and none for a gap of only spaces (REV7-APPS-1)', () => {
  const Real = Intl.Segmenter;
  let built = 0;
  Intl.Segmenter = class extends Real {
    constructor(...args) {
      super(...args);
      built += 1;
    }
  };
  try {
    // 2,000 words a token each, and a comma after every tenth one.
    const words = Array.from({ length: 2000 }, (_, i) => (i % 10 === 9 ? 'ab,' : 'ab'));
    const text = words.join(' ');
    const tokens = [];
    let at = 0;
    for (const w of words) {
      tokens.push({ begin: at, end: at + 2 });
      at += w.length + 1;
    }
    const added = gapTokenize(text, [[0, at - 1]], tokens, 'und-x-gaps');
    assert.equal(added.length, 200);
    gapTokenize(text, [[0, at - 1]], tokens, 'und-x-gaps');
    assert.ok(built <= 1, `${built} segmenters`);
  } finally {
    Intl.Segmenter = Real;
  }
});

test('a token never begins or ends with whitespace, though a segment may (REV7-IGT-2)', () => {
  // A soft hyphen joins the space before it under UAX #29.
  assert.deepEqual(basicTokenize('a ­ b'), [
    [0, 1],
    [2, 3],
    [4, 5],
  ]);
  assert.deepEqual(gapTokenize('a\t­', [[0, 3]], [{ begin: 0, end: 1 }]), [[2, 3]]);
});
