// A CoNLL-U form glued to the one before it (SpaceAfter=No) that composes
// with it: a lone combining mark after a letter, a trailing Hangul jamo. The
// composed text holds neither form, so each form is found by its letters and
// every edge is moved by the server's composing rule. Inputs from the
// H12-IO hunt (work/H12-IO/in/hard-text.conllu, hard-notext.conllu).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildConlluHierarchy, parseCoNLLU } from '../src/utils/conlluParser.js';
import { ConlluDocument } from '../src/domain/ConlluDocument.js';
import { rawDocFromConllu } from './helpers/rawDoc.js';

const row = (id, form, head, deprel, misc = '_') =>
  [id, form, form, 'X', '_', '_', head, deprel, '_', misc].join('\t');

const HARD = (withText) =>
  [
    '# sent_id = 1',
    ...(withText ? ['# text = ba\u0301 ka'] : []),
    row(1, 'ba', 0, 'root', 'SpaceAfter=No'),
    row(2, '\u0301', 1, 'dep'),
    row(3, 'ka', 1, 'dep'),
    '',
    '# sent_id = 2',
    ...(withText ? ['# text = \u1100\u1161\u11a8 \ud55c'] : []),
    row(1, '\u1100\u1161', 0, 'root', 'SpaceAfter=No'),
    row(2, '\u11a8', 1, 'dep'),
    row(3, '\ud55c', 1, 'dep'),
    '',
  ].join('\n');

// As the importer reads a file: every value composed after parsing.
const nfc = (v) =>
  typeof v === 'string'
    ? v.normalize('NFC')
    : Array.isArray(v)
      ? v.map(nfc)
      : v && typeof v === 'object'
        ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, nfc(x)]))
        : v;

const extents = (h) => h.sentences.map((s) => s.words.map((w) => [w.begin, w.end]));
// Each word's letters in the stored text.
const placed = (h) => {
  const cps = [...h.text];
  return h.sentences.map((s) => s.words.map((w) => cps.slice(w.begin, w.end).join('')));
};
const nfcOf = (...parts) => parts.join('').normalize('NFC');

for (const withText of [true, false]) {
  test(`glued forms that compose are placed on their own letters (${withText ? 'with' : 'no'} # text)`, () => {
    const h = buildConlluHierarchy(nfc(parseCoNLLU(HARD(withText))));
    assert.equal(h.text.normalize('NFC'), 'bá ka\n각 한');
    assert.equal(h.dropped.syntheticOffsetSentences, 0);
    // Each glued pair holds the letters of its two forms and nothing else, the
    // second starting where the first ends: no word lands on a space and
    // nothing is padded. Where the mark goes inside the pair is the server's
    // composing rule (`composeText`).
    const [[ba, mark, ka], [ga, jamo, han]] = placed(h);
    assert.equal(nfcOf(ba, mark), 'bá');
    assert.equal(ka, 'ka');
    assert.equal(nfcOf(ga, jamo), '각');
    assert.equal(han, '한');
    const [s1, s2] = extents(h);
    assert.equal(s1[1][0], s1[0][1]);
    assert.equal(s2[1][0], s2[0][1]);
    if (withText) assert.equal(h.sentences[0].metadata.text, 'bá ka');
  });
}

test('a glued form keeps its own letter where the composed text can be cut there', () => {
  // e, then dot below and acute: ẹ composes, the acute stays a character of
  // its own, so the second form keeps a letter of its own.
  const input = [
    '# text = ẹ́ ka',
    row(1, 'e', 0, 'root', 'SpaceAfter=No'),
    row(2, '̣́', 1, 'dep'),
    row(3, 'ka', 1, 'dep'),
  ].join('\n');
  const h = buildConlluHierarchy(nfc(parseCoNLLU(input)));
  assert.equal(h.text.normalize('NFC'), 'ẹ́ ka');
  assert.equal(h.dropped.syntheticOffsetSentences, 0);
  const [[e, marks, ka]] = placed(h);
  assert.ok(e && marks, JSON.stringify([e, marks]));
  assert.equal(nfcOf(e, marks), 'ẹ́');
  assert.equal(ka, 'ka');
});

test('a # text spelled differently from the forms is still matched by its letters', () => {
  // The text written decomposed, its forms composed, with a double space the
  // forms do not say.
  const input = [
    '# text = cafe\u0301  ni\u00f1o',
    row(1, 'caf\u00e9', 0, 'root'),
    row(2, 'nin\u0303o', 1, 'dep'),
  ].join('\n');
  const h = buildConlluHierarchy(nfc(parseCoNLLU(input)));
  assert.equal(h.text, 'caf\u00e9  ni\u00f1o');
  assert.equal(h.dropped.syntheticOffsetSentences, 0);
  assert.deepEqual(extents(h), [
    [
      [0, 4],
      [6, 10],
    ],
  ]);
});

const exportRows = (input) =>
  new ConlluDocument({ raw: rawDocFromConllu(input, 'm') })
    .toConllu()
    .split('\n')
    .filter((l) => /^\d/.test(l))
    .map((l) => l.split('\t'));

test('the export writes SpaceAfter=No on the row of the form the mark was glued to', () => {
  const input = [
    '# text = \u1eb9\u0301 ka',
    row(1, 'e', 0, 'root', 'SpaceAfter=No'),
    row(2, '\u0323\u0301', 1, 'dep'),
    row(3, 'ka', 1, 'dep'),
  ].join('\n');
  assert.deepEqual(
    exportRows(input).map((r) => [r[1], r[9]]),
    [
      ['e', 'SpaceAfter=No'],
      ['\u0323\u0301', '_'],
      ['ka', '_'],
    ],
  );
});

test('the export writes SpaceAfter=No on the row before a word of no width', () => {
  // How a word of no width shows is not settled (H12-IO-1). Only where the
  // glue goes is asserted: on the row before it, not on it.
  assert.deepEqual(
    exportRows(HARD(false)).map((r) => r[9]),
    ['SpaceAfter=No', '_', '_', 'SpaceAfter=No', '_', '_'],
  );
});
