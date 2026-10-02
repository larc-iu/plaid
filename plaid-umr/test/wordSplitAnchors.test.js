// A word split in two in IGT (Tokenize, `ikian,` into `ikian` and `,`) leaves
// a node anchored to the word standing over both halves: core splits only
// the layers under the word layer, and the node layer is a root layer
// (H5-UMR-2). The open puts the node on the half its word's letters are in:
// the half with the most letters, the first of them on a tie. The export
// then aligns it to that word alone. Only the words at either end of an
// anchor are read so: a run of words with no space between them there is
// read as one word split, and a node anchored to such a run on purpose (two
// words IGT tokenized with no space between, `do` and `n't`) is put on one
// of them too, since nothing stored tells the two apart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseUmrFile } from '../src/domain/format/umrFile.js';
import { planImport } from '../src/domain/umrImport.js';
import { UmrDocument } from '../src/domain/UmrDocument.js';
import { rawFromPlan } from './rawFromPlan.js';
import { openInUmr, openWritesNothing, splitWord, wordsOf } from './igtEdits.js';

const SEP = '#'.repeat(80);
const FILE = `${SEP}
# :: snt1
Index: 1 2 3
Words: tsa ikian, a.

# sentence level graph:
(s1t / tsa
    :mod (s1i / ikian)
    :mod (s1a / a)
    :mod (s1b / both))

# alignment:
s1t: 1-1
s1i: 2-2
s1a: 3-3
s1b: 1-2

# document level annotation:
(s1s0 / sentence)
`;

const load = () => rawFromPlan(planImport(parseUmrFile(FILE).sentences, []));
const word = (raw, text) => {
  const body = [...raw.textLayers[0].text.body];
  return wordsOf(raw).find((w) => body.slice(w.begin, w.end).join('') === text);
};
const alignment = (raw) =>
  new Map(
    new UmrDocument({ raw: structuredClone(raw) }).graph.sentences[0].nodes.map((n) => [
      n.var,
      n.alignment.map(([a, b]) => `${a}-${b}`).join(','),
    ]),
  );

test('a node over a word split in two is put on the half with its letters, once', async () => {
  const raw = load();
  const w = word(raw, 'ikian,');
  splitWord(raw, w.id, w.begin + 5);
  // Before the open the node stands over both halves, words 2 and 3.
  assert.equal(alignment(raw).get('s1i'), '2-3');
  const result = await openInUmr(raw);
  // `s1i`, and `both`, which stood over `tsa ikian,` (see below).
  assert.equal(result.wordSplits, 2);
  assert.equal(alignment(raw).get('s1i'), '2-2');
  assert.match(new UmrDocument({ raw: structuredClone(raw) }).toUmr(), /\ns1i: 2-2\n/);
  assert.ok(await openWritesNothing(raw));
});

test('a tie in letters keeps the first half, and punctuation counts for none', async () => {
  const raw = load();
  const a = word(raw, 'a.');
  splitWord(raw, a.id, a.begin + 1);
  const t = word(raw, 'tsa');
  splitWord(raw, t.id, t.begin + 1);
  await openInUmr(raw);
  const at = alignment(raw);
  // `a.` is `a` and `.`: the letter is in the first.
  assert.equal(at.get('s1a'), '4-4');
  // `tsa` is `t` and `sa`: the second has more letters.
  assert.equal(at.get('s1t'), '2-2');
});

test('a node over two words keeps both, and drops the half split off its last', async () => {
  const raw = load();
  const w = word(raw, 'ikian,');
  splitWord(raw, w.id, w.begin + 5);
  await openInUmr(raw);
  // `both` stood over `tsa ikian,`, words 1 and 2, and is back over them.
  assert.equal(alignment(raw).get('s1b'), '1-2');
});

test('a node over two words a space apart, none split, is left as it is', async () => {
  const raw = load();
  assert.equal(alignment(raw).get('s1b'), '1-2');
  await openInUmr(raw);
  assert.equal(alignment(raw).get('s1b'), '1-2');
});
