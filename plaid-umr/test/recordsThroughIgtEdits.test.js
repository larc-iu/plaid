// What a sentence's record (its file number, its gloss and metadata lines, a
// graph kept as text, the relations held for it, the triples between two
// constants its block writes) survives of another app's edits to the shared
// sentences and words, with UMR opened between them or not (igtEdits.js
// models core's side):
//
// - Joining two sentences (igt's Merge with above) deletes the second
//   sentence token. The record is a token of its own over the sentence's
//   text, so both records stand where they were, and splitting the sentence
//   again where it was joined gives each sentence its record back.
// - "Clear sentences" joins every sentence into the first, and splitting the
//   text again at every old boundary gives every record back.
// - A triple between two constants written in two sentences' blocks, as
//   `(root :modal author)` is, comes back in both after a join, an open and
//   a split.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseUmrFile } from '../src/domain/format/umrFile.js';
import { planImport } from '../src/domain/umrImport.js';
import { UmrDocument } from '../src/domain/UmrDocument.js';
import { toUmrSentences } from '../src/domain/sentenceGraph.js';
import { rawFromPlan } from './rawFromPlan.js';
import {
  clearSentences,
  deleteText,
  deleteWord,
  layersOf,
  mergeSentence,
  mergeWords,
  openInUmr,
  openWritesNothing,
  respell,
  sentencesOf,
  splitSentenceAt,
  splitWord,
  typeAtSentenceStart,
  wordsOf,
} from './igtEdits.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, 'fixtures', 'umr');
const fixture = (name) =>
  rawFromPlan(
    planImport(parseUmrFile(fs.readFileSync(path.join(FIXTURES, name), 'utf8')).sentences, []),
  );

// What must survive, sentence by sentence, with every variable read as the
// node it names, since a join, an open and a split rename variables
// (`s7r` back as `s7r3`): the record (number, stored lines, metadata lines, a
// graph kept as text with its alignment), the graph, and the document-level
// block, held relations and triples between constants included. The words,
// the word alignment and the gloss lines laid under the words are left out:
// a word deleted or respelled in IGT changes them, as it should.
function canon(raw) {
  const doc = new UmrDocument({ raw: structuredClone(raw) });
  const g = doc.graph;
  const nodes = [...g.nodesById.values()];
  const anywhere = new Map(nodes.map((n) => [n.var, n.constant ? `const:${n.var}` : n.id]));
  return toUmrSentences(g).map((s, i) => {
    const here = new Map(nodes.filter((n) => n.sentence === s.index).map((n) => [n.var, n.id]));
    const id = (v) => here.get(v) ?? anywhere.get(v) ?? v;
    const own = g.sentences[i];
    return {
      snt: s.snt,
      meta: s.meta,
      stored: own.storedIlg,
      rawGraph: s.rawGraph ?? null,
      rawAlignment: s.rawAlignment ?? null,
      root: s.graph ? id(s.graph.root) : null,
      graph: s.graph
        ? [...s.graph.nodes.values()]
            .map((n) => [
              id(n.var),
              n.concept,
              n.children.map((c) => [c.rel, c.kind, c.kind === 'node' ? id(c.value) : c.value]),
            ])
            .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
        : null,
      triples: s.docGraph
        ? ['temporal', 'modal', 'coref']
            .flatMap((k) => s.docGraph[k].map(([a, r, b]) => `${k} ${id(a)} ${r} ${id(b)}`))
            .sort()
        : [],
    };
  });
}

const boundaries = (raw) =>
  sentencesOf(raw)
    .slice(1)
    .map((s) => s.begin);

// ----- the cases the hunter found (H25-UMR2) -----

test('a join and a split back keep a graph kept as text, its held relations and its lines', async () => {
  const raw = fixture('sanapana_umr-0001.umr');
  const before = canon(raw);
  const doc = new UmrDocument({ raw: structuredClone(raw) });
  const kept = doc.graph.sentences.find((s) => s.rawGraph && s.held.length && s.index > 1);
  assert.ok(kept, 'the fixture has a later sentence kept as text with relations held for it');
  const at = sentencesOf(raw)[kept.index - 1].begin;
  mergeSentence(raw, kept.index);
  // Joined, the sentence reads the first half's record, and the second's
  // waits beside it.
  const joined = new UmrDocument({ raw: structuredClone(raw) }).graph.sentences[kept.index - 2];
  assert.equal(joined.otherRecords.length, 1);
  await openInUmr(raw);
  assert.ok(splitSentenceAt(raw, at));
  await openInUmr(raw);
  assert.deepEqual(canon(raw), before);
  assert.ok(await openWritesNothing(raw));
});

test('Clear sentences and a split at every old boundary give every record back', async () => {
  for (const name of ['arapaho_umr-0001.umr', 'sanapana_umr-0001.umr']) {
    const raw = fixture(name);
    const before = canon(raw);
    const at = boundaries(raw);
    clearSentences(raw);
    await openInUmr(raw);
    at.forEach((b) => assert.ok(splitSentenceAt(raw, b)));
    await openInUmr(raw);
    assert.deepEqual(canon(raw), before, name);
    assert.ok(await openWritesNothing(raw), name);
  }
});

test('a triple between two constants comes back in both blocks after a join, an open and a split', async () => {
  const SEP = '#'.repeat(80);
  const block = (n, words) => `${SEP}
# :: snt${n}
Index: 1 2 3
Words: ${words}

# sentence level graph:
(s${n}g / gel-01
    :ARG1 (s${n}a / person))

# alignment:
s${n}g: 2-2
s${n}a: 1-1

# document level annotation:
(s${n}s0 / sentence
    :modal ((root :modal author)
        (author :full-affirmative s${n}g)))
`;
  const raw = rawFromPlan(
    planImport(
      parseUmrFile([1, 2, 3].map((n) => block(n, 'Ali geldi .')).join('\n')).sentences,
      [],
    ),
  );
  const export0 = new UmrDocument({ raw: structuredClone(raw) }).toUmr();
  assert.equal(export0.match(/\(root :modal author\)/g).length, 3);
  const at = sentencesOf(raw)[1].begin;
  mergeSentence(raw, 2);
  await openInUmr(raw);
  assert.ok(splitSentenceAt(raw, at));
  await openInUmr(raw);
  const export1 = new UmrDocument({ raw: structuredClone(raw) }).toUmr();
  assert.equal(export1.match(/\(root :modal author\)/g).length, 3);
  assert.ok(await openWritesNothing(raw));
});

// ----- a record kept over its whole share of its sentence (REV-FX-UMR2 F1) -----

// What a sentence's own record says, by sentence.
const records = (raw) =>
  new UmrDocument({ raw: structuredClone(raw) }).graph.sentences.map((s) => [s.snt, s.meta]);

const recordTokenOf = (raw, sentence) =>
  layersOf(raw)
    .nodes.tokens.filter((t) => t.metadata?.umr)
    .find((t) => t.begin >= sentence.begin && t.begin < sentence.end);

test('text typed at a sentence start, an open, then its old text deleted, keeps the record', async () => {
  const raw = fixture('english_umr-0001.umr');
  const before = records(raw);
  const third = sentencesOf(raw)[2];
  const { begin, end } = third;
  typeAtSentenceStart(raw, begin, 'Dun ');
  // Core moves the record along and grows the sentence over the new word.
  assert.equal(recordTokenOf(raw, sentencesOf(raw)[2]).begin, begin + 4);
  await openInUmr(raw);
  // The open puts the record back over the whole sentence.
  assert.deepEqual((({ begin: b, end: e }) => [b, e])(recordTokenOf(raw, sentencesOf(raw)[2])), [
    begin,
    end + 4,
  ]);
  // The sentence's old text deleted, its line end with it: `Dun ` is left.
  deleteText(raw, begin + 4, end + 4);
  assert.equal(sentencesOf(raw).length, before.length);
  assert.deepEqual(records(raw), before);
  assert.ok(await openWritesNothing(raw));
});

test('a record left over part of its sentence is put back over its share, and survives a delete there', async () => {
  const raw = fixture('english_umr-0001.umr');
  const before = records(raw);
  const [, second] = sentencesOf(raw);
  const firstWord = wordsOf(raw).find((w) => w.begin === second.begin);
  // As a split at a new place and a join back left it before core stopped
  // cutting a token of another layer at a split: over the first word only.
  recordTokenOf(raw, second).end = firstWord.end;
  await openInUmr(raw);
  const record = recordTokenOf(raw, sentencesOf(raw)[1]);
  assert.deepEqual([record.begin, record.end], [second.begin, second.end]);
  deleteText(raw, second.begin, firstWord.end + 1);
  assert.deepEqual(records(raw), before);
  assert.ok(await openWritesNothing(raw));
});

test('records waiting in a joined sentence each keep their begin and cover up to the next', async () => {
  const raw = fixture('english_umr-0001.umr');
  const [, second, third] = sentencesOf(raw);
  const at = third.begin;
  mergeSentence(raw, 3);
  // Both records shortened at their ends, as text deleted there would.
  recordTokenOf(raw, second).end = second.begin + 2;
  const waiting = layersOf(raw).nodes.tokens.find((t) => t.metadata?.umr && t.begin === at);
  waiting.end = at + 2;
  await openInUmr(raw);
  assert.deepEqual(
    [recordTokenOf(raw, second).begin, recordTokenOf(raw, second).end],
    [second.begin, at],
  );
  assert.deepEqual([waiting.begin, waiting.end], [at, third.end]);
  assert.ok(await openWritesNothing(raw));
});

// ----- random edits (the hunter's property) -----

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Random sentence joins, Clear sentences, word deletes, splits, joins and
// respells, and split-backs at old boundaries, with an open at random
// points when `opens`. Then every old boundary is split again, and UMR
// opened. Returns the raw document and the log.
async function run(base, seed, steps, opens, { text = false } = {}) {
  const rand = rng(seed);
  const pick = (a) => a[Math.floor(rand() * a.length)];
  const raw = structuredClone(base);
  let bounds = boundaries(raw);
  // Which original sentence each word was in: words of two never join.
  const S0 = sentencesOf(raw);
  const origin = new Map(
    wordsOf(raw).map((w) => [w.id, S0.findIndex((s) => s.begin <= w.begin && w.begin < s.end)]),
  );
  const log = [];
  for (let step = 0; step < steps; step++) {
    const sentences = sentencesOf(raw);
    const words = wordsOf(raw);
    const op = rand();
    // Text typed at a sentence's start, or a run of words' text deleted
    // inside one original sentence, leaving it a word and its line end.
    if (text && op < 0.12) {
      const s = pick(sentences);
      typeAtSentenceStart(raw, s.begin, 'Dun ');
      bounds = bounds.map((b) => (b > s.begin ? b + 4 : b));
      log.push(`type-at ${s.begin}`);
      continue;
    }
    if (text && op < 0.24) {
      const o = origin.get(pick(words).id);
      const inside = words.filter((w) => o != null && origin.get(w.id) === o);
      if (inside.length < 2) continue;
      const i = Math.floor(rand() * inside.length);
      const j = i + Math.floor(rand() * (inside.length - i - 1));
      const from = inside[i].begin;
      const body = [...raw.textLayers[0].text.body];
      let to = inside[j].end;
      if (body[to] === ' ') to += 1;
      deleteText(raw, from, to);
      const at = (x) => (x <= from ? x : x >= to ? x - (to - from) : from);
      bounds = bounds.map(at);
      log.push(`delete-text ${from}-${to}`);
      continue;
    }
    if (op < 0.25 && sentences.length > 1) {
      const i = 2 + Math.floor(rand() * (sentences.length - 1));
      mergeSentence(raw, i);
      log.push(`merge ${i}`);
    } else if (op < 0.29) {
      clearSentences(raw);
      log.push('clear');
    } else if (op < 0.38 && words.length > 3) {
      const w = pick(words);
      deleteWord(raw, w.id);
      log.push(`delete-word ${w.begin}`);
    } else if (op < 0.52) {
      const w = pick(words.filter((x) => x.end - x.begin >= 2));
      if (!w) continue;
      const from = w.begin + 1 + Math.floor(rand() * (w.end - w.begin - 1));
      const to = from + Math.floor(rand() * (w.end - from + 1));
      const insert = pick(['', 'a', 'ɨɨ', 'xyz']);
      if ((from === to && !insert) || !respell(raw, from, to, insert)) continue;
      const d = [...insert].length - (to - from);
      bounds = bounds.map((b) => (b > from ? b + d : b));
      log.push(`respell ${from}-${to} '${insert}'`);
    } else if (op < 0.62) {
      const w = pick(words.filter((x) => x.end - x.begin >= 2));
      if (!w) continue;
      const at = w.begin + 1 + Math.floor(rand() * (w.end - w.begin - 1));
      origin.set(splitWord(raw, w.id, at), origin.get(w.id));
      log.push(`split-word ${w.begin}@${at}`);
    } else if (op < 0.7) {
      const i = Math.floor(rand() * (words.length - 1));
      const [a, b] = [words[i], words[i + 1]];
      if (!b || origin.get(a.id) !== origin.get(b.id)) continue;
      const s = sentences.find((x) => x.begin <= a.begin && a.begin < x.end);
      if (!(b.begin < s.end)) continue;
      mergeWords(raw, a.id, b.id);
      log.push(`merge-words ${a.begin}`);
    } else if (op < 0.82) {
      const b = pick(bounds);
      if (b != null && splitSentenceAt(raw, b)) log.push(`split-back ${b}`);
    } else if (opens) {
      await openInUmr(raw);
      log.push('open');
    }
  }
  bounds.forEach((b) => splitSentenceAt(raw, b));
  if (opens) await openInUmr(raw);
  return { raw, log };
}

const FUZZ = [
  ['sanapana_umr-0001.umr', 12],
  ['arapaho_umr-0001.umr', 3],
  ['english_umr-0001.umr', 12],
  ['navajo_umr-0001.umr', 12],
  ['kukama_umr-0001.umr', 12],
  ['chinese_tlp_chapter2.umr', 4],
  ['portuguese_umr-0001.umr', 12],
];

// What the records say, sentence by sentence: what text edits must leave.
const recordCanon = (raw) =>
  new UmrDocument({ raw: structuredClone(raw) }).graph.sentences.map((s) => ({
    snt: s.snt,
    meta: s.meta,
    stored: s.storedIlg,
    rawGraph: s.rawGraph,
    rawAlignment: s.rawAlignment,
    held: s.held,
    triples: s.triples.map((t) => t.id).sort(),
  }));

for (const [name, runs] of FUZZ) {
  test(`${name}: every record survives text typed and deleted in IGT among the other edits`, async () => {
    const base = fixture(name);
    const before = recordCanon(base);
    for (let seed = 1; seed <= runs; seed++) {
      const { raw, log } = await run(base, 1000 + seed, 30, true, { text: true });
      const why = `seed ${1000 + seed}: ${log.join(' | ')}`;
      // A triple on a node whose words were deleted goes with it: compare the
      // ones between two constants, which no text holds.
      const constOnly = (c) => c.map((x) => ({ ...x, triples: undefined, held: undefined }));
      assert.deepEqual(constOnly(recordCanon(raw)), constOnly(before), why);
      assert.ok(await openWritesNothing(raw), `second open writes: ${why}`);
    }
  });
}

for (const [name, runs] of FUZZ) {
  test(`${name}: every record and triple survives random edits in IGT, opened or not`, async () => {
    const base = fixture(name);
    const before = canon(base);
    for (let seed = 1; seed <= runs; seed++) {
      for (const opens of [true, false]) {
        const { raw, log } = await run(base, seed, 30, opens);
        const why = `seed ${seed}${opens ? '' : ', never opened'}: ${log.join(' | ')}`;
        assert.deepEqual(canon(raw), before, why);
        if (opens) assert.ok(await openWritesNothing(raw), `second open writes: ${why}`);
      }
    }
  });
}
