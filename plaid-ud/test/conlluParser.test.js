// Astral-text coverage for CoNLL-U import offset computation. Word begin/end
// are Unicode CODE POINTS. Uses Node's built-in test runner — run `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseCoNLLU,
  buildConlluHierarchy,
  splitConlluByNewdoc,
} from '../src/utils/conlluParser.js';

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

test('a unit placed past the text it cannot be found in starts after a space, not on it', () => {
  // A multi-word token whose FORM is not in `# text` (H4-UD-5): placed after
  // `mercado`, it starts on the `d` of `dul`, not on the space before it.
  const h = buildConlluHierarchy(
    parseCoNLLU(
      conllu([
        '# text = mercado dul pueblo',
        '1\tmercado\t_\t_\t_\t_\t_\t_\t_\t_',
        '2-3\tdel\t_\t_\t_\t_\t_\t_\t_\t_',
        '2\tde\t_\t_\t_\t_\t_\t_\t_\t_',
        '3\tel\t_\t_\t_\t_\t_\t_\t_\t_',
        '4\tpueblo\t_\t_\t_\t_\t_\t_\t_\t_',
      ]),
    ),
  );
  assert.equal(h.dropped.syntheticOffsetSentences, 1);
  const [, mwt] = h.sentences[0].words;
  assert.equal(h.text.slice(mwt.begin, mwt.end), 'dul');
});

// H3-5-10: a refusal named neither the sentence nor the cause, and an empty
// FORM reached the server, whose refusal spoke of nested token layers.
test('a refusal names its sentence and what is wrong in CoNLL-U terms', () => {
  const row = (id, form = 'w') => `${id}\t${form}\t_\tX\t_\t_\t_\t_\t_\t_`;
  const refusal = (lines) => {
    try {
      parseCoNLLU(conllu(lines));
    } catch (e) {
      return e.message;
    }
    return null;
  };
  // Two sentences with no blank line between them.
  assert.equal(
    refusal(['# sent_id = a', row(1), row(2), row(3), '# sent_id = b', row(1), row(2)]),
    'Invalid token ordering in sentence 1 (sent_id a): a new sentence begins after ID 3 with no blank line before it.',
  );
  // An ID 1 said twice, with no comment line between, is a repeat.
  assert.equal(
    refusal([row(1), row(1), row(2)]),
    'Invalid token ordering in sentence 1: expected ID 2, found 1.',
  );
  // A duplicate ID in the second sentence, and a gap.
  assert.equal(
    refusal([row(1), '', '# sent_id = x-2', row(1), row(2), row(2)]),
    'Invalid token ordering in sentence 2 (sent_id x-2): expected ID 3, found 2.',
  );
  assert.equal(
    refusal([row(1), row(2), row(4)]),
    'Invalid token ordering in sentence 1: expected ID 3, found 4.',
  );
  assert.equal(refusal([row(1), '', row(1, '')]), 'Empty FORM in sentence 2, ID 1.');
  assert.equal(refusal([row(1), '', row('x')]), 'Invalid token ID in sentence 2: x');
  assert.equal(refusal(['1\tw\t_\tX\t_\t_\tx\tdep\t_\t_']), 'Invalid HEAD value in sentence 1: x');
  assert.equal(
    refusal(['1-1\tw\t_\t_\t_\t_\t_\t_\t_\t_', row(1)]),
    'Invalid multi-word token range in sentence 1: 1-1',
  );
});

// H3-5-4: parseInt read ID `2a` as 2 and HEAD `1.5` as 1.
test('an ID, HEAD or range bound that is not a whole number is refused', () => {
  const refusal = (lines) => {
    try {
      parseCoNLLU(conllu(lines));
    } catch (e) {
      return e.message;
    }
    return null;
  };
  assert.equal(
    refusal(['1\ta\t_\tX\t_\t_\t0\troot\t_\t_', '2a\tb\t_\tX\t_\t_\t1\tdep\t_\t_']),
    'Invalid token ID in sentence 1: 2a',
  );
  assert.equal(
    refusal(['1\ta\t_\tX\t_\t_\t0\troot\t_\t_', '2\tb\t_\tX\t_\t_\t1.5\tdep\t_\t_']),
    'Invalid HEAD value in sentence 1: 1.5',
  );
  assert.equal(
    refusal(['1\ta\t_\tX\t_\t_\t0\troot\t_\t_', '2\tb\t_\tX\t_\t_\t+1\tdep\t_\t_']),
    'Invalid HEAD value in sentence 1: +1',
  );
  assert.equal(
    refusal([
      '1-2x\tab\t_\t_\t_\t_\t_\t_\t_\t_',
      '1\ta\t_\tX\t_\t_\t0\troot\t_\t_',
      '2\tb\t_\tX\t_\t_\t1\tdep\t_\t_',
    ]),
    'Invalid multi-word token range in sentence 1: 1-2x',
  );
});

// H3-5-3: a range past the last row was cut short and one overlapping
// another was left out, both in silence.
test('a multi-word token range past the last row, or over another, is refused', () => {
  const refusal = (lines) => {
    try {
      parseCoNLLU(conllu(lines));
    } catch (e) {
      return e.message;
    }
    return null;
  };
  assert.equal(
    refusal([
      '# text = abc',
      '1-2\tab\t_\t_\t_\t_\t_\t_\t_\t_',
      '1\ta\t_\tX\t_\t_\t0\troot\t_\t_',
      '2-3\tbc\t_\t_\t_\t_\t_\t_\t_\t_',
      '2\tb\t_\tX\t_\t_\t1\tdep\t_\t_',
      '3\tc\t_\tX\t_\t_\t1\tdep\t_\t_',
    ]),
    'Invalid multi-word token range in sentence 1: 2-3 overlaps 1-2.',
  );
  assert.equal(
    refusal([
      '# text = onetwo',
      '1-3\tonetwo\t_\t_\t_\t_\t_\t_\t_\t_',
      '1\tone\t_\tX\t_\t_\t0\troot\t_\t_',
      '2\ttwo\t_\tX\t_\t_\t1\tdep\t_\t_',
    ]),
    'Invalid multi-word token range in sentence 1: 1-3 runs past the last ID, 2.',
  );
});

// H3-5-7: comment lines before the first `# newdoc id` (a licence, CoNLL-U
// Plus's `# global.columns`) became a document of their own, refused as
// holding no sentences.
test('comment lines before the first newdoc go with the first document', () => {
  const chunks = splitConlluByNewdoc(
    [
      '# This treebank is licensed CC BY-SA 4.0.',
      '# Annotated by the Kukama team, 2026.',
      '',
      '# newdoc id = licdoc',
      '# sent_id = l-1',
      '1\ta\t_\tX\t_\t_\t0\troot\t_\t_',
      '',
      '# newdoc id = second',
      '1\tb\t_\tX\t_\t_\t0\troot\t_\t_',
    ].join('\n'),
  );
  assert.deepEqual(
    chunks.map((c) => c.id),
    ['licdoc', 'second'],
  );
  const [first] = parseCoNLLU(chunks[0].text).sentences;
  assert.equal(first.metadata['This treebank is licensed CC BY-SA 4.0.'], true);
  assert.equal(first.metadata.sent_id, 'l-1');
  // A file with rows before its first newdoc keeps them as a document.
  assert.deepEqual(
    splitConlluByNewdoc(
      [
        '1\ta\t_\tX\t_\t_\t0\troot\t_\t_',
        '',
        '# newdoc id = d',
        '1\tb\t_\tX\t_\t_\t0\troot\t_\t_',
      ].join('\n'),
    ).map((c) => c.id),
    [null, 'd'],
  );
});
