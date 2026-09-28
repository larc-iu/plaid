// What a sentence token records of its sentence (the file's `snt` number, its
// gloss and metadata lines, the relations held on it) after IGT adds a
// sentence, and the numbers the export writes:
//
// - IGT splits keeping the token on the LEFT, so a sentence typed in before
//   an existing one takes that one's token and its record, while the words
//   and the graph the record describes are in the right half. The reader
//   reads the record with its graph, reconcile moves it there, and the export
//   writes each `# :: snt` number once (the official validator refuses a
//   repeat: `non-unique-sent-id`).
// - A triple between two constants lists the sentences whose blocks write it
//   by number, so it follows its sentences in the same way.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyMetadataOps } from '@larc-iu/plaid-client';
import { parseUmrFile } from '../src/domain/format/umrFile.js';
import { planImport } from '../src/domain/umrImport.js';
import { UmrDocument } from '../src/domain/UmrDocument.js';
import { toUmrSentences } from '../src/domain/sentenceGraph.js';
import { rawFromPlan } from './rawFromPlan.js';
import { recordingClient } from './recordingClient.js';
import { insertSentenceAtStart } from './igtInsertSentence.js';

const SEP = '#'.repeat(80);
const block = (n, words = 'Ali geldi .') => `${SEP}
# :: snt${n}
Index: 1 2 3
Words: ${words}
Gloss: Ali came .

# sentence level graph:
(s${n}g / gel-01
    :ARG1 (s${n}a / person))

# alignment:
s${n}g: 2-2
s${n}a: 1-1

# document level annotation:
(s${n}s0 / sentence
    :modal ((root :modal author)))
`;

const role = (raw, r) => raw.textLayers[0].tokenLayers.find((l) => l.config?.plaid?.role === r);
const fromText = (text) => rawFromPlan(planImport(parseUmrFile(text).sentences, []));

function open(raw) {
  const { client, calls } = recordingClient();
  client.tokens.update = async (...args) => calls.push({ name: 'tokens.update', args });
  const doc = new UmrDocument({ raw, client });
  doc._reload = async () => {};
  doc.onError = (msg) => {
    throw new Error(msg);
  };
  return { doc, calls };
}

// The metadata patches a pass sent, applied to the raw document, as the
// server would.
function applyPatches(raw, calls) {
  const layer = raw.textLayers[0];
  const all = (kind) =>
    kind === 'tokens'
      ? layer.tokenLayers.flatMap((l) => l.tokens)
      : kind === 'spans'
        ? layer.tokenLayers.flatMap((l) => (l.spanLayers || []).flatMap((s) => s.spans))
        : layer.tokenLayers.flatMap((l) =>
            (l.spanLayers || []).flatMap((s) =>
              (s.relationLayers || []).flatMap((r) => r.relations),
            ),
          );
  calls.forEach(({ name, args }) => {
    const [kind, what] = name.split('.');
    if (what !== 'patchMetadata') return;
    const target = all(kind).find((x) => x.id === args[0]);
    target.metadata = applyMetadataOps(target.metadata || {}, args[1]);
  });
}

const constantTriple = (doc) =>
  doc.graph.constants.flatMap((c) => c.docOut).find((t) => t.rel === ':modal');

test('a sentence typed in before the first leaves the first sentence its file record', async () => {
  const raw = fromText(`${block(1)}\n${block(2)}`);
  const kept = insertSentenceAtStart(raw);
  const { doc, calls } = open(raw);
  const [fresh, first, second] = doc.graph.sentences;
  // The new text, which holds the old first sentence's token, reads as new.
  assert.equal(fresh.tokenId, kept);
  assert.equal(fresh.snt, null);
  assert.deepEqual(fresh.storedIlg, []);
  assert.deepEqual(fresh.triples, []);
  // The old first sentence reads its record, and its block's relation.
  assert.equal(first.snt, 1);
  assert.equal(first.storedIlg[0]?.header, 'Gloss');
  assert.deepEqual(
    first.triples.map((t) => t.rel),
    [':modal'],
  );
  assert.deepEqual(
    second.triples.map((t) => t.rel),
    [':modal'],
  );

  // Every `# :: snt` number once, by position, before any repair.
  const numbers = toUmrSentences(doc.graph).map((s) => s.snt);
  assert.deepEqual(numbers, [1, 2, 3]);
  assert.match(doc.toUmr(), /# :: snt1\n[^]*# :: snt2\n[^]*# :: snt3\n/);

  // The repair moves the record for good, and the relation's numbers.
  const result = await doc._reconcile();
  assert.equal(result.recordsMoved, 1);
  assert.equal(result.triplesMoved, 1);
  const tokenPatches = calls
    .filter((c) => c.name === 'tokens.patchMetadata')
    .map((c) => [c.args[0], c.args[1].map((o) => `${o.op} ${o.path.join('.')}`)]);
  assert.deepEqual(tokenPatches, [
    ['igt-right', ['set umr']],
    [kept, ['delete umr']],
  ]);
  const triplePatch = calls.find((c) => c.name === 'relations.patchMetadata');
  assert.deepEqual(triplePatch.args[1], [{ op: 'set', path: ['umr', 'sentences'], value: [2, 3] }]);
  assert.equal(
    doc.describeReconcile(result),
    'Repaired: moved the stored lines of 1 sentence to the sentence they describe, moved 1 document-level relation between constants to its sentences, renumbered 4 variables to match the sentences',
  );

  // Once written, the document reads the same and a second pass finds nothing.
  applyPatches(raw, calls);
  const again = open(raw);
  assert.deepEqual(
    again.doc.graph.sentences.map((s) => [s.snt, s.triples.length]),
    [
      [null, 0],
      [1, 1],
      [2, 1],
    ],
  );
  assert.deepEqual(constantTriple(again.doc).metadata.umr.sentences, [2, 3]);
  assert.deepEqual(await again.doc._reconcile(), { findings: [] });
  assert.deepEqual(
    toUmrSentences(again.doc.graph).map((s) => s.snt),
    [1, 2, 3],
  );
});

test('a sentence split in two in IGT keeps its record on the half with its graph', () => {
  // "Ali geldi ." split after "Ali": both halves hold nodes of sentence 1,
  // and the left one, which keeps the token, keeps the record.
  const raw = fromText(`${block(1)}\n${block(2)}`);
  const sentences = role(raw, 'sentence').tokens;
  const first = sentences[0];
  sentences.push({ id: 'igt-right', begin: first.begin + 4, end: first.end });
  first.end = first.begin + 4;
  const { doc } = open(raw);
  const [left, right] = doc.graph.sentences;
  assert.equal(left.snt, 1);
  assert.equal(right.snt, null);
  assert.equal(left.recordToken, left.tokenId);
});

test('a sentence added after the last reads as new, and the rest keep their records', () => {
  const raw = fromText(`${block(1)}\n${block(2)}`);
  const layer = raw.textLayers[0];
  const end = [...layer.text.body].length;
  layer.text.body += 'Yeni cümle .\n';
  role(raw, 'sentence').tokens.push({ id: 'igt-new', begin: end, end: end + 13 });
  const { doc } = open(raw);
  assert.deepEqual(
    doc.graph.sentences.map((s) => s.snt),
    [1, 2, null],
  );
  assert.deepEqual(
    toUmrSentences(doc.graph).map((s) => s.snt),
    [1, 2, 3],
  );
});

test('an excerpt keeps its file numbers, and a sentence typed in before it takes a free one', () => {
  const raw = fromText(`${block(5)}\n${block(6)}`);
  insertSentenceAtStart(raw);
  const { doc } = open(raw);
  assert.deepEqual(
    doc.graph.sentences.map((s) => s.snt),
    [null, 5, 6],
  );
  assert.deepEqual(
    toUmrSentences(doc.graph).map((s) => s.snt),
    [1, 5, 6],
  );
});

test('an excerpt numbered from 2 with a sentence typed in after its first never repeats a number', () => {
  const raw = fromText(`${block(2)}\n${block(3)}`);
  const layer = raw.textLayers[0];
  const firstEnd = role(raw, 'sentence').tokens[0].end;
  // IGT absorbs text typed at the boundary into the sentence before it, and
  // the split keeps that one's token on the left.
  const shift = 13;
  const body = [...layer.text.body];
  layer.text.body = [...body.slice(0, firstEnd), ...'Yeni cümle .\n', ...body.slice(firstEnd)].join(
    '',
  );
  layer.tokenLayers.forEach((l) =>
    l.tokens.forEach((t) => {
      if (t.begin >= firstEnd) {
        t.begin += shift;
        t.end += shift;
      }
    }),
  );
  role(raw, 'sentence').tokens.push({ id: 'igt-mid', begin: firstEnd, end: firstEnd + shift });
  const { doc } = open(raw);
  assert.deepEqual(
    doc.graph.sentences.map((s) => s.snt),
    [2, null, 3],
  );
  // Position 2 is the first sentence's stored number, so the new one takes
  // the next number past every other.
  assert.deepEqual(
    toUmrSentences(doc.graph).map((s) => s.snt),
    [2, 4, 3],
  );
});

test('a triple between constants follows its sentences past one typed in between them', async () => {
  const raw = fromText(`${block(1)}\n${block(2)}\n${block(3)}`);
  const layer = raw.textLayers[0];
  const firstEnd = role(raw, 'sentence').tokens[0].end;
  const shift = 13;
  const body = [...layer.text.body];
  layer.text.body = [...body.slice(0, firstEnd), ...'Yeni cümle .\n', ...body.slice(firstEnd)].join(
    '',
  );
  layer.tokenLayers.forEach((l) =>
    l.tokens.forEach((t) => {
      if (t.begin >= firstEnd) {
        t.begin += shift;
        t.end += shift;
      }
    }),
  );
  role(raw, 'sentence').tokens.push({ id: 'igt-mid', begin: firstEnd, end: firstEnd + shift });
  const { doc, calls } = open(raw);
  assert.deepEqual(
    doc.graph.sentences.map((s) => s.triples.length),
    [1, 0, 1, 1],
  );
  const result = await doc._reconcile();
  assert.equal(result.triplesMoved, 1);
  assert.equal(result.recordsMoved, 0);
  assert.deepEqual(calls.find((c) => c.name === 'relations.patchMetadata').args[1], [
    { op: 'set', path: ['umr', 'sentences'], value: [1, 3, 4] },
  ]);
});
