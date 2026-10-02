// What a sentence's record holds of it (the file's `snt` number, its gloss
// and metadata lines, the relations held on it, the triples between two
// constants its block writes) after IGT adds a sentence, and the numbers the
// export writes:
//
// - A record is a token of the node layer over its sentence's text, so text
//   typed in before a sentence moves it along with the sentence, and the
//   export writes each `# :: snt` number once (the official validator
//   refuses a repeat: `non-unique-sent-id`).
// - A record left on new text before the sentence it describes is read with
//   its graph, and reconcile moves it there.
// - A triple between two constants listed by number (as the canvas writes
//   one) goes into the records of its sentences.
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
  const nodeLayer = layer.tokenLayers.find((l) => l.config?.umr?.nodes);
  calls.forEach(({ name, args }) => {
    if (name === 'tokens.update') {
      const target = all('tokens').find((x) => x.id === args[0]);
      [target.begin, target.end] = [args[1], args[2]];
      return;
    }
    if (name === 'tokens.bulkCreate') {
      args[0].forEach((t) =>
        nodeLayer.tokens.push({ id: t.id, begin: t.begin, end: t.end, metadata: t.metadata }),
      );
      return;
    }
    const [kind, what] = name.split('.');
    if (what !== 'patchMetadata') return;
    const target = all(kind).find((x) => x.id === args[0]);
    target.metadata = applyMetadataOps(target.metadata || {}, args[1]);
  });
}

// The record token of each sentence, by position.
const recordTokens = (raw) =>
  raw.textLayers[0].tokenLayers
    .find((l) => l.config?.umr?.nodes)
    .tokens.filter((t) => t.metadata?.umr)
    .sort((a, b) => a.begin - b.begin);

test('a sentence typed in before the first leaves every record with its sentence', async () => {
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

  // Every `# :: snt` number once, by position.
  const numbers = toUmrSentences(doc.graph).map((s) => s.snt);
  assert.deepEqual(numbers, [1, 2, 3]);
  assert.match(doc.toUmr(), /# :: snt1\n[^]*# :: snt2\n[^]*# :: snt3\n/);

  // Nothing of the records needs moving: only the variables are renumbered.
  const result = await doc._reconcile();
  assert.equal(result.recordsMoved, 0);
  assert.equal(result.triplesMoved, 0);
  assert.equal(result.renumbered, 4);
  assert.deepEqual(
    calls.filter((c) => c.name.startsWith('tokens.') || c.name.startsWith('relations.')),
    [],
  );
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
  assert.deepEqual(await again.doc._reconcile(), { findings: [] });
});

test('a record left on new text typed in before its sentence goes back to it', async () => {
  const raw = fromText(`${block(1)}\n${block(2)}`);
  insertSentenceAtStart(raw, 'Yeni cümle .', { recordCut: true });
  const [cut] = recordTokens(raw);
  const { doc, calls } = open(raw);
  const [fresh, first] = doc.graph.sentences;
  // Read with the graph it describes before any repair.
  assert.equal(fresh.snt, null);
  assert.deepEqual(fresh.triples, []);
  assert.equal(first.snt, 1);
  assert.equal(first.recordToken, cut.id);
  assert.deepEqual(
    first.triples.map((t) => t.rel),
    [':modal'],
  );
  assert.deepEqual(
    toUmrSentences(doc.graph).map((s) => s.snt),
    [1, 2, 3],
  );
  const result = await doc._reconcile();
  assert.equal(result.recordsMoved, 1);
  assert.deepEqual(calls.find((c) => c.name === 'tokens.update').args, [
    cut.id,
    first.begin,
    first.end,
  ]);
  assert.equal(
    doc.describeReconcile(result),
    'Repaired: moved the stored lines of 1 sentence to the sentence they describe, renumbered 4 variables to match the sentences',
  );
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
  assert.deepEqual(await again.doc._reconcile(), { findings: [] });
});

test('a triple between constants listed by number goes into the records of its sentences', async () => {
  const raw = fromText(`${block(1)}\n${block(2)}\n${block(3)}`);
  const records = recordTokens(raw);
  const triple = raw.textLayers[0].tokenLayers
    .find((l) => l.config?.umr?.nodes)
    .spanLayers[0].relationLayers.find((l) => l.config?.umr?.documentGraph)
    .relations.find((r) => r.value === ':modal');
  // As the canvas or a script writes one: by the sentences' numbers. The
  // third sentence was made in Plaid and has no record.
  records.forEach((t) => delete t.metadata.umr.triples);
  const nodeLayer = raw.textLayers[0].tokenLayers.find((l) => l.config?.umr?.nodes);
  nodeLayer.tokens = nodeLayer.tokens.filter((t) => t !== records[2]);
  triple.metadata.umr.sentences = [1, 3, 9];
  const { doc, calls } = open(raw);
  assert.deepEqual(
    doc.graph.sentences.map((s) => s.triples.length),
    [1, 0, 1],
  );
  const result = await doc._reconcile();
  assert.equal(result.triplesMoved, 1);
  assert.deepEqual(calls.find((c) => c.name === 'relations.patchMetadata').args, [
    triple.id,
    [{ op: 'set', path: ['umr', 'sentences'], value: [9] }],
  ]);
  assert.deepEqual(calls.find((c) => c.name === 'tokens.patchMetadata').args, [
    records[0].id,
    [{ op: 'set', path: ['umr', 'triples'], value: [triple.id] }],
  ]);
  const made = calls.find((c) => c.name === 'tokens.bulkCreate').args[0];
  assert.equal(made.length, 1);
  assert.deepEqual(made[0].metadata, { umr: { triples: [triple.id] } });
  assert.equal(made[0].begin, doc.graph.sentences[2].begin);
  applyPatches(raw, calls);
  const again = open(raw);
  assert.deepEqual(
    again.doc.graph.sentences.map((s) => s.triples.length),
    [1, 0, 1],
  );
  assert.deepEqual(await again.doc._reconcile(), { findings: [] });
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
  assert.ok(left.recordToken);
  assert.equal(right.recordToken, null);
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
  // The records list it, so nothing about it is written.
  const result = await doc._reconcile();
  assert.equal(result.triplesMoved, 0);
  assert.equal(result.recordsMoved, 0);
  assert.equal(
    calls.find((c) => c.name === 'relations.patchMetadata' || c.name === 'tokens.patchMetadata'),
    undefined,
  );
});
