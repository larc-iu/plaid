// Astral-text coverage for CoNLL-U import offset computation. Word begin/end
// are Unicode CODE POINTS. Uses Node's built-in test runner — run `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseCoNLLU, buildConlluHierarchy } from '../src/utils/conlluParser.js';

const conllu = (lines) => lines.join('\n') + '\n';

test('buildConlluHierarchy locates forms in code points across an astral char', () => {
  // "😀 cat": 😀 is one code point, so "cat" is [2,5] (UTF-16 would be [3,6]).
  const h = buildConlluHierarchy(
    parseCoNLLU(
      conllu([
        '# text = 😀 cat',
        '1\t😀\t_\t_\t_\t_\t_\t_\t_\t_',
        '2\tcat\t_\t_\t_\t_\t_\t_\t_\t_',
      ]),
    ),
  );
  assert.equal(h.text, '😀 cat');
  assert.deepEqual(
    h.sentences[0].words.map((w) => [w.surfaceForm, w.begin, w.end]),
    [
      ['😀', 0, 1],
      ['cat', 2, 5],
    ],
  );
});

test('reports synthetic offsets when a form cannot be located in the sentence text', () => {
  // `# text` is present but does not contain the tokens' surface forms (the
  // no-space-script / mismatched-text case). The builder falls back to gap-free
  // synthetic placement and must report the sentence via dropped, so the import
  // UI can warn the user rather than dropping the fidelity loss into console.warn.
  const h = buildConlluHierarchy(
    parseCoNLLU(
      conllu(['# text = 不见', '1\tcat\t_\t_\t_\t_\t_\t_\t_\t_', '2\tdog\t_\t_\t_\t_\t_\t_\t_\t_']),
    ),
  );
  assert.equal(h.dropped.syntheticOffsetSentences, 1);
  // Synthetic placement tiles the words gap-free even though the offsets do not
  // correspond to the original text.
  const words = h.sentences[0].words;
  assert.equal(words[0].begin, 0);
  assert.equal(words[1].begin, words[0].end);
});

test('does not report synthetic offsets when every form is located', () => {
  const h = buildConlluHierarchy(
    parseCoNLLU(
      conllu([
        '# text = the cat',
        '1\tthe\t_\t_\t_\t_\t_\t_\t_\t_',
        '2\tcat\t_\t_\t_\t_\t_\t_\t_\t_',
      ]),
    ),
  );
  assert.equal(h.dropped.syntheticOffsetSentences, 0);
});

test('sentence offsets advance in code points across sentences', () => {
  // Two single-word sentences joined by a newline; the second sentence's word
  // offset must count the astral char + newline as code points.
  const h = buildConlluHierarchy(
    parseCoNLLU(
      conllu([
        '# text = 😀',
        '1\t😀\t_\t_\t_\t_\t_\t_\t_\t_',
        '',
        '# text = ok',
        '1\tok\t_\t_\t_\t_\t_\t_\t_\t_',
      ]),
    ),
  );
  assert.equal(h.text, '😀\nok'); // code points: 😀(0) \n(1) o(2) k(3)
  // second sentence word "ok" begins at code-point 2 (after 😀 + newline)
  assert.deepEqual(
    h.sentences[1].words.map((w) => [w.begin, w.end]),
    [[2, 4]],
  );
});

test('rows that are complete but out of order are refused', () => {
  // The check used to sort the ids first, so 1, 3, 2 passed. The importer
  // reads a relation's target by array POSITION and its head by id, so an
  // accepted out-of-order sentence wires the tree to the wrong words.
  const src =
    '1\ta\ta\tX\t_\t_\t0\troot\t_\t_\n3\tc\tc\tX\t_\t_\t1\tdep\t_\t_\n2\tb\tb\tX\t_\t_\t1\tdep\t_\t_\n';
  assert.throws(() => parseCoNLLU(src), /token ordering/);
});

test('a multi-word token range does not count as a row', () => {
  const src =
    '1\tVamos\tir\tVERB\t_\t_\t0\troot\t_\t_\n' +
    '2-3\tal\t_\t_\t_\t_\t_\t_\t_\t_\n' +
    '2\ta\ta\tADP\t_\t_\t4\tcase\t_\t_\n' +
    '3\tel\tel\tDET\t_\t_\t4\tdet\t_\t_\n' +
    '4\tmar\tmar\tNOUN\t_\t_\t1\tobl\t_\t_\n';
  const { sentences } = parseCoNLLU(src);
  assert.deepEqual(
    sentences[0].tokens.map((t) => t.id),
    [1, 2, 3, 4],
  );
});
