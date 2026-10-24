// A word split in two in IGT (Tokenize, `ikian,` into `ikian` and `,`) leaves
// a node anchored to the word standing over both halves: core splits only
// the layers under the word layer, and the node layer is a root layer
// (H5-UMR-2). The open puts the node on the half its word's letters are in:
// the half with the most letters, the first of them on a tie. The export
// then aligns it to that word alone. A node records the words it was
// aligned to, and a split keeps a word's id on its left half, so only a
// word the node does not record, touching a recorded one, is read as a half.
// A node aligned on purpose to several touching words (`do` and `n't`, or
// any compound in a text with no spaces, as Chinese is) is left as it is
// (H34-UMR-1, where every such node was cut to one word on each open).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseUmrFile } from '../src/domain/format/umrFile.js';
import { importUmrDocument, planImport } from '../src/domain/umrImport.js';
import { getUmrLayerInfo } from '../src/utils/umrLayerUtils.js';
import { UmrDocument } from '../src/domain/UmrDocument.js';
import { rawFromPlan } from './rawFromPlan.js';
import { twoWriterCore } from './twoWriterCore.js';
import {
  deleteText,
  deleteWord,
  mergeWords,
  layersOf,
  openInUmr,
  openWritesNothing,
  splitWord,
  wordsOf,
} from './igtEdits.js';

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

test('the record follows the cut, so a second open writes nothing', async () => {
  const raw = load();
  const w = word(raw, 'ikian,');
  splitWord(raw, w.id, w.begin + 5);
  await openInUmr(raw);
  const doc = new UmrDocument({ raw: structuredClone(raw) });
  const node = doc.graph.sentences[0].nodes.find((n) => n.var === 's1i');
  assert.deepEqual(node.metadata.umr.words, node.wordIds);
  assert.ok(await openWritesNothing(raw));
});

test('a node that records no words is never cut', async () => {
  const raw = load();
  layersOf(raw).concepts.spans.forEach((s) => delete s.metadata.umr.words);
  const w = word(raw, 'ikian,');
  splitWord(raw, w.id, w.begin + 5);
  const result = await openInUmr(raw);
  assert.ok(!result.wordSplits);
  assert.equal(alignment(raw).get('s1i'), '2-3');
});

// A text with no spaces between its words, as a Chinese IGT text is.
const SPACELESS = `${SEP}
# :: snt1
Index: 1 2 3 4
Words: 能 谈得 来 吗

# sentence level graph:
(s1n / 能-01
    :ARG0 (s1t / 谈得来)
    :mod (s1d / 谈得)
    :mod (s1p / 能谈得))

# alignment:
s1n: 1-1
s1t: 2-3
s1d: 2-2
s1p: 1-2

# document level annotation:
(s1s0 / sentence)
`;

function spaceless(text = SPACELESS) {
  const raw = rawFromPlan(planImport(parseUmrFile(text).sentences, []));
  for (;;) {
    const ws = wordsOf(raw);
    const gap = ws.findIndex((w, i) => i > 0 && ws[i - 1].end < w.begin);
    if (gap < 0) return raw;
    deleteText(raw, ws[gap - 1].end, ws[gap].begin);
  }
}

test('a node aligned to touching words in a text with no spaces keeps them all', async () => {
  const raw = spaceless();
  assert.equal(raw.textLayers[0].text.body.split('\n')[0], '能谈得来吗');
  assert.equal(alignment(raw).get('s1t'), '2-3');
  assert.equal(alignment(raw).get('s1p'), '1-2');
  assert.ok(await openWritesNothing(raw));
  assert.equal(alignment(raw).get('s1t'), '2-3');
});

test('in a text with no spaces, only a word really split is cut', async () => {
  const raw = spaceless();
  const w = word(raw, '谈得');
  splitWord(raw, w.id, w.begin + 1);
  const result = await openInUmr(raw);
  // `s1d` stood on 谈得, and `s1p` on 能谈得, whose last word was split. `s1t`
  // stood on 谈得来, whose FIRST word was split: the halves 谈 and 得 tie on
  // letters, the first wins, and its anchor still begins where it did, so
  // nothing is cut (the next test has halves that do not tie).
  assert.equal(result.wordSplits, 2);
  const at = alignment(raw);
  assert.equal(at.get('s1d'), '2-2');
  assert.equal(at.get('s1p'), '1-2');
  assert.equal(at.get('s1t'), '2-4');
  assert.ok(await openWritesNothing(raw));
});

test('a node anchored on the canvas to touching words keeps them on the next open', async () => {
  const core = twoWriterCore(spaceless());
  const page = await core.open('a');
  const s = page.doc.sentence(1);
  const node = s.nodes.find((n) => n.var === 's1n');
  const words = s.words.slice(1, 4).map((w) => w.id);
  assert.ok(await page.doc.setAnchor(node.id, words));
  const made = await page.doc.createNode({
    sentenceIndex: 1,
    concept: 'new',
    wordIds: s.words.slice(0, 2).map((w) => w.id),
  });
  assert.ok(made);
  page.release();
  const raw = core.raw;
  assert.equal(alignment(raw).get('s1n'), '2-4');
  assert.equal(alignment(raw).get('s1n2'), '1-2');
  assert.ok(await openWritesNothing(raw));
  assert.equal(alignment(raw).get('s1n'), '2-4');
});

test('a node anchored again to both halves of a split word keeps them', async () => {
  const raw = load();
  const w = word(raw, 'ikian,');
  splitWord(raw, w.id, w.begin + 5);
  const core = twoWriterCore(raw);
  const page = await core.open('a');
  const node = page.doc.sentence(1).nodes.find((n) => n.var === 's1i');
  // The same words as are under it already, but not the words it records.
  assert.ok(await page.doc.setAnchor(node.id, [...node.wordIds]));
  page.release();
  // `both`, on `tsa ikian,`, is cut. `s1i` is not.
  assert.equal((await openInUmr(core.raw)).wordSplits, 1);
  assert.equal(alignment(core.raw).get('s1i'), '2-3');
  assert.equal(alignment(core.raw).get('s1b'), '1-2');
});

test('an import onto a document with words records the words each node is aligned to', async () => {
  // The document's own words, with no graph yet: what an IGT text is.
  const raw = spaceless();
  const L = layersOf(raw);
  L.nodes.tokens = [];
  L.concepts.spans = [];
  L.relations.relations = [];
  L.triples.relations = [];
  const core = twoWriterCore(raw);
  const body = raw.textLayers[0].text.body;
  const { attached } = await importUmrDocument(
    core.client('a'),
    'p',
    'doc',
    SPACELESS,
    getUmrLayerInfo(raw),
    { into: raw.id },
  );
  assert.ok(attached);
  assert.equal(core.raw.textLayers[0].text.body, body);
  const doc = new UmrDocument({ raw: structuredClone(core.raw) });
  const node = doc.graph.sentences[0].nodes.find((n) => n.var === 's1t');
  assert.deepEqual(node.metadata.umr.words, node.wordIds);
  assert.equal(node.wordIds.length, 2);
  assert.ok(await openWritesNothing(core.raw));
});

const UNEQUAL = `${SEP}
# :: snt1
Index: 1 2 3
Words: 能 谈得来 吗

# sentence level graph:
(s1n / 能-01
    :ARG0 (s1t / 谈得来吗)
    :mod (s1p / 能谈得来))

# alignment:
s1n: 1-1
s1t: 2-3
s1p: 1-2

# document level annotation:
(s1s0 / sentence)
`;

test('a split word at the start of an anchor keeps its half with more letters, so the anchor loses the other', async () => {
  const raw = spaceless(UNEQUAL);
  const w = word(raw, '谈得来');
  splitWord(raw, w.id, w.begin + 1);
  await openInUmr(raw);
  const at = alignment(raw);
  // 谈|得来 at the start of `s1t`: 得来 has more letters, and 谈 is dropped.
  assert.equal(at.get('s1t'), '3-4');
  // At the end of `s1p` the half kept is the last, so its anchor is whole.
  assert.equal(at.get('s1p'), '1-3');
  assert.ok(await openWritesNothing(raw));
});

// REV-FX3-UMR F1: words reshaped under a node by something other than a
// split (a merge then a split, or a word deleted and made again) leave a
// recorded id that is gone, and the node is not cut.
test('a merge then a split inside a two-word alignment cuts nothing', async () => {
  const raw = spaceless(UNEQUAL);
  const core = twoWriterCore(raw);
  const page = await core.open('a');
  const s = page.doc.sentence(1);
  const node = s.nodes.find((n) => n.var === 's1n');
  // 能|谈得来, aligned on purpose.
  assert.ok(await page.doc.setAnchor(node.id, [s.words[0].id, s.words[1].id]));
  page.release();
  const fixed = core.raw;
  mergeWords(fixed, word(fixed, '能').id, word(fixed, '谈得来').id);
  const merged = word(fixed, '能谈得来');
  splitWord(fixed, merged.id, merged.begin + 3);
  assert.equal(alignment(fixed).get('s1n'), '1-2');
  const result = await openInUmr(fixed);
  assert.ok(!result.wordSplits);
  assert.equal(alignment(fixed).get('s1n'), '1-2');
});

test('a word deleted and made again over its text at the end of an alignment cuts nothing', async () => {
  const raw = spaceless(UNEQUAL);
  const w = word(raw, '吗');
  deleteWord(raw, w.id);
  layersOf(raw).word.tokens.push({ id: 'remade', begin: w.begin, end: w.end });
  assert.equal(alignment(raw).get('s1t'), '2-3');
  const result = await openInUmr(raw);
  assert.ok(!result.wordSplits);
  assert.equal(alignment(raw).get('s1t'), '2-3');
});

// REV-FX3-UMR F3: a node the open makes unaligned records its sentence and no words.
test('a node whose word is deleted records no words once the open unaligns it', async () => {
  const raw = spaceless(UNEQUAL);
  deleteWord(raw, word(raw, '能').id);
  await openInUmr(raw);
  const span = layersOf(raw).concepts.spans.find((x) => x.metadata.umr.var === 's1n');
  assert.ok(span.metadata.umr.sentence);
  assert.equal(span.metadata.umr.words, undefined);
});

// REV-FX3-UMR F2: words asked for that the sentence no longer has.
test('a node made on words that are gone is aligned to the rest, or to none', async () => {
  const core = twoWriterCore(spaceless(UNEQUAL));
  const page = await core.open('a');
  const s = page.doc.sentence(1);
  const ghost = await page.doc.createNode({
    sentenceIndex: 1,
    concept: 'ghost',
    wordIds: ['gone'],
  });
  const some = await page.doc.createNode({
    sentenceIndex: 1,
    concept: 'some',
    wordIds: ['gone', s.words[2].id],
  });
  const node = s.nodes.find((n) => n.var === 's1n');
  assert.equal(await page.doc.setAnchor(node.id, ['gone']), false);
  page.release();
  const doc = new UmrDocument({ raw: structuredClone(core.raw) });
  const g = doc.node(ghost.nodeId);
  assert.equal(g.aligned, false);
  assert.equal(g.metadata.umr.words, undefined);
  assert.ok(g.metadata.umr.sentence);
  const m = doc.node(some.nodeId);
  assert.deepEqual(m.wordIds, [s.words[2].id]);
  assert.deepEqual(m.metadata.umr.words, [s.words[2].id]);
  assert.equal(alignment(core.raw).get('s1n'), '1-1');
});

// H34-UMR polish: the tie-break counts marks with the letters, from the
// generated table (letterClasses.js), not the runtime's Unicode classes.
// `कीं` is one letter and two vowel marks, `खग` two letters.
const MARKED = `${SEP}
# :: snt1
Index: 1
Words: कींखग

# sentence level graph:
(s1k / कींखग)

# alignment:
s1k: 1-1

# document level annotation:
(s1s0 / sentence)
`;

test('a vowel mark counts as a letter when a split word picks its half', async () => {
  const raw = rawFromPlan(planImport(parseUmrFile(MARKED).sentences, []));
  const w = word(raw, 'कींखग');
  splitWord(raw, w.id, w.begin + 3);
  const result = await openInUmr(raw);
  assert.equal(result.wordSplits, 1);
  assert.equal(alignment(raw).get('s1k'), '1-1');
});

test('the letter table is what tools/letterClasses.mjs writes, and the cut reads only it', async () => {
  const { LETTER_MARK_OR_NUMBER, isLetterMarkOrNumber } = await import(
    '../src/domain/letterClasses.js'
  );
  if (process.versions.unicode === '16.0') {
    const ranges = [];
    for (let cp = 0; cp <= 0x10ffff; cp++) {
      if (!/[\p{L}\p{M}\p{N}]/u.test(String.fromCodePoint(cp))) continue;
      const last = ranges.at(-1);
      if (last && last[1] === cp - 1) last[1] = cp;
      else ranges.push([cp, cp]);
    }
    assert.deepEqual(LETTER_MARK_OR_NUMBER, ranges);
  }
  assert.equal(isLetterMarkOrNumber('\u0902'), true);
  assert.equal(isLetterMarkOrNumber('7'), true);
  assert.equal(isLetterMarkOrNumber(','), false);
  assert.equal(isLetterMarkOrNumber(''), false);
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../src/domain/umrReconcile.js', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('export function planWordSplits'));
  assert.doesNotMatch(body.slice(0, body.indexOf('\n}\n')), /\\p\{/);
});
