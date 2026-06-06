// Astral-text coverage for CoNLL-U import offset computation. Word begin/end
// are Unicode CODE POINTS. Uses Node's built-in test runner — run `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseCoNLLU, buildConlluHierarchy } from '../src/utils/conlluParser.js';

const conllu = (lines) => lines.join('\n') + '\n';

test('buildConlluHierarchy locates forms in code points across an astral char', () => {
  // "😀 cat": 😀 is one code point, so "cat" is [2,5] (UTF-16 would be [3,6]).
  const h = buildConlluHierarchy(parseCoNLLU(conllu([
    '# text = 😀 cat',
    '1\t😀\t_\t_\t_\t_\t_\t_\t_\t_',
    '2\tcat\t_\t_\t_\t_\t_\t_\t_\t_',
  ])));
  assert.equal(h.text, '😀 cat');
  assert.deepEqual(
    h.sentences[0].words.map(w => [w.surfaceForm, w.begin, w.end]),
    [['😀', 0, 1], ['cat', 2, 5]],
  );
});

test('sentence offsets advance in code points across sentences', () => {
  // Two single-word sentences joined by a newline; the second sentence's word
  // offset must count the astral char + newline as code points.
  const h = buildConlluHierarchy(parseCoNLLU(conllu([
    '# text = 😀',
    '1\t😀\t_\t_\t_\t_\t_\t_\t_\t_',
    '',
    '# text = ok',
    '1\tok\t_\t_\t_\t_\t_\t_\t_\t_',
  ])));
  assert.equal(h.text, '😀\nok'); // code points: 😀(0) \n(1) o(2) k(3)
  // second sentence word "ok" begins at code-point 2 (after 😀 + newline)
  assert.deepEqual(h.sentences[1].words.map(w => [w.begin, w.end]), [[2, 4]]);
});
