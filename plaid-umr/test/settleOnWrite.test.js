// Opening a UMR document writes nothing (Luke's ruling R3, 2026-10-24). What
// another app's edit left UMR's rows not saying is read right by the reader,
// and the first UMR write to a sentence stores it there (umrSettle.js), sent
// before the write's own requests in its operation. A write stores only the
// sentences it writes, and a row the server has not made yet is left alone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseUmrFile } from '../src/domain/format/umrFile.js';
import { planImport } from '../src/domain/umrImport.js';
import { UmrDocument } from '../src/domain/UmrDocument.js';
import { isRecordToken } from '../src/domain/sentenceGraph.js';
import { planSettle } from '../src/domain/umrSettle.js';
import { rawFromPlan } from './rawFromPlan.js';
import { recordingClient } from './recordingClient.js';
import { insertSentenceAtStart } from './igtInsertSentence.js';
import { clientOver, layersOf, openWritesNothing, splitWord, wordsOf } from './igtEdits.js';

const SEP = '#'.repeat(80);
const TEXT = `${SEP}
# :: snt1
Index: 1 2 3
Words: Ali geldi .

# sentence level graph:
(s1g / gel-01
    :ARG1 (s1a / person))

# alignment:
s1g: 2-2
s1a: 1-1

# document level annotation:
(s1s0 / sentence)

${SEP}
# :: snt2
Index: 1 2 3 4 5
Words: Evimizde misafirler yemek yediler .

# sentence level graph:
(s2y / ye-01
    :ARG0 (s2m / misafir)
    :ARG1 (s2y2 / yemek)
    :place (s2e / ev))

# alignment:
s2y: 4-4
s2m: 2-2
s2y2: 3-3
s2e: 1-1

# document level annotation:
(s2s0 / sentence
    :temporal ((s1g :before s2y)))
`;

const wordAt = (raw, text) => {
  const body = [...raw.textLayers[0].text.body];
  return wordsOf(raw).find((w) => body.slice(w.begin, w.end).join('') === text);
};

// A document with something of every kind to store, as IGT's edits leave
// it: a sentence typed in before the first (every variable's number moves,
// and the old first sentence's token now stands on the new text), a word
// deleted under a node, a word split in two under a node, a record narrower
// than its sentence, an entry the vocabulary no longer has, and a node
// outside every sentence.
function everyKind() {
  const raw = rawFromPlan(planImport(parseUmrFile(TEXT).sentences, []));
  const L = layersOf(raw);
  L.nodes.tokens.forEach((t) => {
    if (t.metadata?.umr) delete t.metadata.umr.snt;
  });
  const yemek = wordAt(raw, 'yemek');
  L.word.tokens = L.word.tokens.filter((t) => t.id !== yemek.id);
  const evimizde = wordAt(raw, 'Evimizde');
  splitWord(raw, evimizde.id, evimizde.begin + 5);
  const second = [...L.sentence.tokens].sort((a, b) => a.begin - b.begin)[1];
  const record = L.nodes.tokens.find(
    (t) => isRecordToken(t) && t.begin >= second.begin && t.begin < second.end,
  );
  record.end = record.begin + 3;
  const geldi = L.concepts.spans.find((s) => s.metadata.umr.var === 's1g');
  geldi.metadata.umr.entry = 'gone';
  geldi.metadata.umr.entryVocab = 'v1';
  const end = [...raw.textLayers[0].text.body].length;
  L.nodes.tokens.push({ id: 'stray-piece', begin: end, end });
  L.concepts.spans.push({
    id: 'stray',
    value: 'thing',
    tokens: ['stray-piece'],
    metadata: { umr: { var: 's9t', attrs: [], sentence: 'gone' } },
  });
  insertSentenceAtStart(raw);
  return raw;
}

const lexicon = { byId: new Map(), entries: [], readVocabs: new Set(['v1']) };
const byStored = (doc, v) => [...doc.graph.nodesById.values()].find((n) => n.storedVar === v);

test('opening a document with something of every kind to store writes nothing', async () => {
  const raw = everyKind();
  const doc = new UmrDocument({ raw: structuredClone(raw), lexicon });
  const plan = planSettle(doc.graph, null, { lexicon });
  assert.ok(plan.meta.size && plan.updates.length, 'there is something to store');
  assert.ok(await openWritesNothing(raw));
  // A real open on a recording client sends nothing either.
  const { client, calls } = recordingClient();
  const open = new UmrDocument({ raw: structuredClone(raw), client, lexicon });
  await open.reconcileOnOpen();
  assert.deepEqual(
    calls.filter((c) => c.name !== 'operation'),
    [],
  );
});

test('the reader reads every kind as stored', () => {
  const doc = new UmrDocument({ raw: everyKind(), lexicon });
  // Variables by their sentence's number.
  assert.deepEqual(
    doc
      .sentence(3)
      .nodes.map((n) => n.var)
      .sort(),
    ['s3e', 's3m', 's3y', 's3y2'],
  );
  // The node whose word went is aligned to nothing, in its sentence.
  const lost = byStored(doc, 's2y2');
  assert.equal(lost.aligned, false);
  assert.equal(lost.sentence, 3);
  // The node over the split word stands on its half with more letters.
  const split = byStored(doc, 's2e');
  assert.equal(split.wordIds.length, 1);
  assert.deepEqual(split.alignment, [[1, 1]]);
  // The node outside every sentence is not there, and stays stored.
  assert.equal(doc.node('stray'), null);
  assert.ok(layersOf(doc.raw).concepts.spans.some((s) => s.id === 'stray'));
  // The export writes the names the reader gives.
  assert.match(doc.toUmr(), /\(s3y \/ ye-01/);
});

test('a write stores what its sentences read, before its own change, and leaves the others', async () => {
  const raw = everyKind();
  const doc = new UmrDocument({ raw: structuredClone(raw), client: clientOver(raw), lexicon });
  doc._reload = async () => doc._swapRaw(structuredClone(raw));
  const fresh = () => new UmrDocument({ raw: structuredClone(raw), lexicon });
  const pending = (index) => planSettle(fresh().graph, new Set([index]), { lexicon });
  assert.ok(pending(2) && pending(3));
  // A write to sentence 3 (the old second) stores sentence 3's.
  const ye = byStored(doc, 's2y');
  assert.ok(await doc.setConcept(ye.id, 'ye-02'));
  assert.equal(pending(3), null);
  assert.ok(pending(2), 'sentence 2 is not the write`s, and keeps what it has to store');
  const after = fresh();
  assert.equal(byStored(after, 's3y').concept, 'ye-02');
  assert.equal(byStored(after, 's3y2').metadata.umr.sentence, after.sentence(3).tokenId);
  assert.equal(byStored(after, 's3e').metadata.umr.words.length, 1);
  const record = layersOf(raw).nodes.tokens.find((t) => t.id === after.sentence(3).recordToken);
  assert.deepEqual([record.begin, record.end], [after.sentence(3).begin, after.sentence(3).end]);
  // A write to sentence 2 stores the rest, the deleted entry included.
  assert.ok(await doc.setConcept(byStored(doc, 's1a').id, 'woman'));
  assert.equal(planSettle(fresh().graph, null, { lexicon }), null);
  assert.equal(byStored(fresh(), 's2g').metadata.umr.entry, undefined);
  // What was stored reads as it did.
  assert.deepEqual(
    fresh()
      .sentence(3)
      .nodes.map((n) => [n.var, n.storedVar])
      .sort(),
    [
      ['s3e', 's3e'],
      ['s3m', 's3m'],
      ['s3y', 's3y'],
      ['s3y2', 's3y2'],
    ],
  );
});

test('a node the write is making is not stored beside it, and the rest is', async () => {
  const raw = rawFromPlan(planImport(parseUmrFile(TEXT).sentences, []));
  const L = layersOf(raw);
  const yemek = wordAt(raw, 'yemek');
  L.word.tokens = L.word.tokens.filter((t) => t.id !== yemek.id);
  const { client, calls } = recordingClient();
  const doc = new UmrDocument({ raw, client });
  doc._reload = async () => {};
  const lost = byStored(doc, 's2y2');
  const made = await doc.createNode({ sentenceIndex: 2, concept: 'thing' });
  assert.ok(made);
  const writes = calls.filter((c) => c.name !== 'operation');
  // First what the sentence reads: the node whose word went, unaligned.
  assert.equal(writes[0].name, 'spans.patchMetadata');
  assert.equal(writes[0].args[0], lost.id);
  // Nothing of the new node before the request that makes it.
  const create = writes.findIndex((c) => c.name === 'spans.create');
  assert.ok(create > 0);
  assert.ok(writes.slice(0, create).every((c) => !JSON.stringify(c.args).includes(made.nodeId)));
});
