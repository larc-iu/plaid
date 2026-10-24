// Three limits on what the reader shows, and the next write stores, and on
// what Text mode does after IGT changes the sentences (the defaults adopted
// with the rulings of 2026-09-28). The open writes nothing (R3, 2026-10-24):
//
// - Renumbering leaves alone a document whose first stored `snt` number is
//   not 1: a released excerpt starting at `# :: snt5` keeps its names. A
//   sentence deleted later in an imported file does not stop it.
// - Mending a graph kept as text accepts that graph's own names even when IGT
//   has shifted the sentences since. The reader then reads them by their
//   sentence's number, and the next write stores it.
// - A sentence with no words at all (IGT's "Clear tokens", before it tokenizes
//   again) is a tokenization in progress, and its nodes keep their anchors.
//   So is a document with no sentences at all: every node is kept.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseUmrFile } from '../src/domain/format/umrFile.js';
import { planImport } from '../src/domain/umrImport.js';
import { UmrDocument } from '../src/domain/UmrDocument.js';
import { planSettle, umrOps } from '../src/domain/umrSettle.js';
import { rawFromPlan } from './rawFromPlan.js';
import { recordingClient } from './recordingClient.js';
import { insertSentenceAtStart } from './igtInsertSentence.js';

const SEP = '#'.repeat(80);
const block = (n) => `${SEP}
# :: snt${n}
Index: 1 2 3
Words: Ali geldi .

# sentence level graph:
(s${n}g / gel-01
    :ARG1 (s${n}a / person))

# alignment:
s${n}g: 2-2
s${n}a: 1-1

# document level annotation:
(s${n}s0 / sentence)
`;

const SANAPANA = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'umr',
  'sanapana_umr-0001.umr',
);

const role = (raw, r) => raw.textLayers[0].tokenLayers.find((l) => l.config?.plaid?.role === r);

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

const fromText = (text) => rawFromPlan(planImport(parseUmrFile(text).sentences, []));
const vars = (doc) => [...doc.graph.nodesById.values()].map((n) => n.var).sort();
// The names the reader gives in place of the stored ones: [stored, read].
const renamed = (doc) =>
  [...doc.graph.nodesById.values()]
    .filter((n) => n.storedVar !== n.var)
    .map((n) => [n.storedVar, n.var])
    .sort();
// What the next write to every sentence stores (umrSettle.js).
const stores = (doc) => planSettle(doc.graph, null);
// Whether the open sent any write.
const openWrites = async (doc, calls) => {
  await doc.validateOnOpen();
  return calls.filter((c) => c.name !== 'operation').length > 0;
};

// ----- 1. renumbering and the stored sentence numbers -----

test('an excerpt whose file starts at snt5 keeps its variables', async () => {
  const { doc, calls } = open(fromText(`${block(5)}\n${block(6)}`));
  assert.deepEqual(vars(doc), ['s5a', 's5g', 's6a', 's6g']);
  assert.deepEqual(renamed(doc), []);
  assert.equal(stores(doc), null);
  assert.equal(await openWrites(doc, calls), false);
});

test('the same file starting at snt1 with a sentence IGT added before it is renumbered', async () => {
  const raw = fromText(`${block(1)}\n${block(2)}`);
  insertSentenceAtStart(raw);
  const { doc, calls } = open(raw);
  assert.deepEqual(renamed(doc), [
    ['s1a', 's2a'],
    ['s1g', 's2g'],
    ['s2a', 's3a'],
    ['s2g', 's3g'],
  ]);
  assert.equal(await openWrites(doc, calls), false);
  assert.equal([...stores(doc).meta.values()].filter((c) => c.var).length, 4);
});

test('numbers that skip one, as a sentence deleted in IGT leaves them, still renumber', () => {
  const raw = fromText(`${block(1)}\n${block(2)}\n${block(3)}`);
  // IGT deleted sentence 2 with its words, and the cascade took its nodes.
  const second = role(raw, 'sentence').tokens[1];
  role(raw, 'sentence').tokens.splice(1, 1);
  const inside = (t) => t.begin >= second.begin && t.end <= second.end;
  role(raw, 'word').tokens = role(raw, 'word').tokens.filter((t) => !inside(t));
  const nodes = raw.textLayers[0].tokenLayers.find((l) => l.config?.umr?.nodes);
  const gone = new Set(nodes.tokens.filter(inside).map((t) => t.id));
  nodes.tokens = nodes.tokens.filter((t) => !gone.has(t.id));
  nodes.spanLayers[0].spans = nodes.spanLayers[0].spans.filter(
    (s) => !s.tokens.every((t) => gone.has(t)),
  );
  nodes.spanLayers[0].relationLayers.forEach((rl) => {
    const alive = new Set(nodes.spanLayers[0].spans.map((s) => s.id));
    rl.relations = rl.relations.filter((r) => alive.has(r.source) && alive.has(r.target));
  });
  const { doc } = open(raw);
  assert.deepEqual(vars(doc), ['s1a', 's1g', 's2a', 's2g']);
  assert.deepEqual(renamed(doc), [
    ['s3a', 's2a'],
    ['s3g', 's2g'],
  ]);
});

test('a file whose first sentence was deleted in IGT reads as an excerpt, and keeps its names', () => {
  const raw = fromText(`${block(1)}\n${block(2)}`);
  const first = role(raw, 'sentence').tokens[0];
  role(raw, 'sentence').tokens.splice(0, 1);
  const inside = (t) => t.begin >= first.begin && t.end <= first.end;
  role(raw, 'word').tokens = role(raw, 'word').tokens.filter((t) => !inside(t));
  const nodes = raw.textLayers[0].tokenLayers.find((l) => l.config?.umr?.nodes);
  const gone = new Set(nodes.tokens.filter(inside).map((t) => t.id));
  nodes.tokens = nodes.tokens.filter((t) => !gone.has(t.id));
  nodes.spanLayers[0].spans = nodes.spanLayers[0].spans.filter(
    (s) => !s.tokens.every((t) => gone.has(t)),
  );
  nodes.spanLayers[0].relationLayers.forEach((rl) => {
    const alive = new Set(nodes.spanLayers[0].spans.map((s) => s.id));
    rl.relations = rl.relations.filter((r) => alive.has(r.source) && alive.has(r.target));
  });
  const { doc } = open(raw);
  assert.deepEqual(vars(doc), ['s2a', 's2g']);
  assert.deepEqual(renamed(doc), []);
});

// ----- 2. a kept graph mended after IGT shifted the sentences -----

test('a graph kept as text is mended under its own names after IGT added a sentence before it', async () => {
  const raw = rawFromPlan(
    planImport(parseUmrFile(fs.readFileSync(SANAPANA, 'utf8')).sentences, []),
  );
  insertSentenceAtStart(raw);
  const { doc, calls } = open(raw);
  // The old sentence 37, kept as text, is sentence 38 now.
  assert.equal(doc.sentence(38).nodes.length, 0);
  const kept = doc.penmanOf(38);
  assert.match(kept, /\(s37e /);
  const mended = kept.replace('"Río_Verde_Paraguay)', '"Río_Verde_Paraguay")');
  const plan = doc.planPenman(38, mended);
  assert.equal(plan.errors, undefined, JSON.stringify(plan.errors));
  assert.ok((await doc.applyPenman(38, mended)) > 0);
  const docLayer = doc.layerInfo.documentGraphLayer.id;
  const made = calls
    .filter((c) => c.name === 'relations.bulkCreate')
    .flatMap((c) => c.args[0])
    .filter((r) => r.relationLayerId === docLayer);
  assert.equal(made.length, 10, 'every held relation is made real');
  // The reader reads the mended nodes by their sentence's number with the
  // rest, and the next write to the sentence stores it.
  const moved = new Map(renamed(doc));
  assert.equal(moved.get('s37e'), 's38e');
});

test('a new name in a mended kept graph that the kept text did not define keeps the number rule', () => {
  const raw = rawFromPlan(
    planImport(parseUmrFile(fs.readFileSync(SANAPANA, 'utf8')).sentences, []),
  );
  insertSentenceAtStart(raw);
  const { doc } = open(raw);
  const kept = doc.penmanOf(38);
  const mended = kept
    .replace('"Río_Verde_Paraguay)', '"Río_Verde_Paraguay")')
    .replace(/\)\s*$/, ' :mod (s37zz / thing))');
  const plan = doc.planPenman(38, mended);
  assert.ok(
    plan.errors?.some((e) =>
      /s37zz names sentence 37, and the node is in sentence 38/.test(e.message),
    ),
    JSON.stringify(plan.errors),
  );
});

// ----- 3. a sentence with no words at all -----

test('a sentence whose words were all cleared keeps its nodes aligned where they stand', async () => {
  const raw = fromText(`${block(1)}\n${block(2)}`);
  const second = role(raw, 'sentence').tokens[1];
  const inside = (t) => t.begin >= second.begin && t.end <= second.end;
  const words = role(raw, 'word').tokens;
  role(raw, 'word').tokens = words.filter((t) => !inside(t));
  const { doc, calls } = open(raw);
  assert.equal(await openWrites(doc, calls), false);
  assert.equal(stores(doc), null);
  // Tokenized again, the nodes are aligned as they were.
  role(raw, 'word').tokens = words;
  const { doc: again } = open(raw);
  assert.ok(again.sentence(2).nodes.every((n) => n.aligned));
});

test('a document whose sentences were all deleted keeps every node, and its sentences made again take them back', async () => {
  const named = (n) =>
    block(n)
      .replace(
        `:ARG1 (s${n}a / person))`,
        `:ARG1 (s${n}a / person\n        :name (s${n}n / name :op1 "Ali")))`,
      )
      .replace(`s${n}a: 1-1`, `s${n}a: 1-1\ns${n}n: 0-0`);
  const raw = fromText(`${named(1)}\n${named(2)}`);
  const sentenceLayer = role(raw, 'sentence');
  const sentences = sentenceLayer.tokens;
  const words = role(raw, 'word').tokens;
  const before = open(raw).doc;
  const unaligned = [...before.graph.nodesById.values()].filter((n) => !n.constant && !n.aligned);
  assert.equal(unaligned.length, 2);
  // Every sentence deleted, with the words nested in them. The node layer is
  // a root layer of its own, so its tokens, spans and relations stay.
  sentenceLayer.tokens = [];
  role(raw, 'word').tokens = [];
  const { doc, calls } = open(raw);
  assert.equal(doc.graph.sentences.length, 0);
  assert.equal(await openWrites(doc, calls), false);
  assert.equal(stores(doc), null, 'nothing is removed or rewritten');
  assert.equal([...doc.graph.nodesById.values()].length, before.graph.nodesById.size);
  // Tokenized again: new sentence tokens over the same text, and the words.
  sentenceLayer.tokens = sentences.map((t) => ({ ...t, id: `${t.id}-again` }));
  role(raw, 'word').tokens = words;
  const { doc: again } = open(raw);
  const plan = stores(again);
  assert.equal(plan.retoken.length, 0, 'nothing is removed');
  assert.equal(
    [...plan.meta.values()].filter((c) => c.sentence).length,
    unaligned.length,
    'each unaligned node takes its new sentence',
  );
  assert.ok(again.sentence(1).nodes.length && again.sentence(2).nodes.length);
});

test('a sentence that keeps some words still unanchors a node whose word went', async () => {
  const raw = fromText(`${block(1)}\n${block(2)}`);
  const body = raw.textLayers[0].text.body;
  const at = body.indexOf('Ali', role(raw, 'sentence').tokens[1].begin);
  role(raw, 'word').tokens = role(raw, 'word').tokens.filter((t) => t.begin !== at);
  const { doc } = open(raw);
  const node = [...doc.graph.nodesById.values()].find((n) => n.var === 's2a');
  assert.equal(stores(doc).meta.get(node.id).sentence, doc.sentence(2).tokenId);
});

// ----- 4. the vocabulary read -----

test("an open reads no vocabulary, and a write with the vocabularies read keeps a deleted entry's link", async () => {
  const raw = fromText(`${block(1)}`);
  const { client, calls } = recordingClient();
  const asked = [];
  client.vocabLayers = { get: async (id) => (asked.push(id), { id, items: [] }) };
  const node = raw.textLayers[0].tokenLayers.find((l) => l.config?.umr?.nodes).spanLayers[0]
    .spans[0];
  node.metadata.umr.entry = 'gone';
  node.metadata.umr.entryVocab = 'v1';
  const picked = new UmrDocument({ raw, client, project: { vocabs: [{ id: 'v1' }] } });
  picked._reload = async () => {};
  assert.equal(await openWrites(picked, calls), false);
  assert.deepEqual(asked, [], 'the open reads nothing');
  assert.equal(
    stores(picked),
    null,
    'nothing is said of an entry before the vocabularies are read',
  );
  await picked.loadLexicon();
  assert.deepEqual(asked, ['v1']);
  // The lexicon may be older than the link (REV-W2B-OPENS M3).
  assert.equal(stores(picked), null);
});

// ----- 5. a sentence typed in before the first one -----

test("a sentence typed in before the first keeps the first sentence's unaligned node with its tree", async () => {
  const TR = `${SEP}
# :: snt1
Index: 1 2 3 4
Words: Ali kitap verdi .

# sentence level graph:
(s1v / ver-01
    :ARG0 (s1a / person
        :name (s1n / name :op1 "Ali"))
    :ARG1 (s1k / kitap))

# alignment:
s1v: 3-3
s1a: 1-1
s1n: 0-0
s1k: 2-2

# document level annotation:
(s1s0 / sentence)
`;
  const raw = fromText(TR);
  // IGT keeps the first sentence's token on the new text, which s1n records.
  const kept = insertSentenceAtStart(raw);
  const { doc, calls } = open(raw);
  const name = [...doc.graph.nodesById.values()].find((n) => n.storedVar === 's1n');
  assert.equal(name.metadata.umr.sentence, kept);
  // It is read in the sentence its anchor and its parent are in, not the
  // one its record names, so no edge crosses a sentence.
  assert.equal(name.sentence, 2);
  assert.equal(name.aligned, false);
  assert.equal(name.var, 's2n');
  assert.equal(await openWrites(doc, calls), false);
  const plan = stores(doc);
  assert.deepEqual(umrOps(plan.meta.get(name.id)), [
    { op: 'set', path: ['umr', 'sentence'], value: 'igt-right' },
    { op: 'set', path: ['umr', 'var'], value: 's2n' },
  ]);
  assert.equal([...plan.meta.values()].filter((c) => c.var).length, 4);
});

test('a boundary moved later keeps an unaligned node in the sentence it records', () => {
  const raw = fromText(`${block(1)}\n${block(2)}`);
  const [, second] = role(raw, 'sentence').tokens;
  const nodes = raw.textLayers[0].tokenLayers.find((l) => l.config?.umr?.nodes);
  const span = nodes.spanLayers[0].spans.find((s) => s.metadata.umr.var === 's2a');
  // s2a is unaligned: it records sentence 2 and stands over it.
  span.metadata.umr.sentence = second.id;
  const piece = nodes.tokens.find((t) => t.id === span.tokens[0]);
  piece.begin = second.begin;
  piece.end = second.end;
  // IGT moves the boundary between them two characters later: sentence 1
  // takes the start of sentence 2's text, and with it where s2a begins.
  role(raw, 'sentence').tokens[0].end += 2;
  second.begin += 2;
  const { doc } = open(raw);
  assert.equal([...doc.graph.nodesById.values()].find((n) => n.var === 's2a').sentence, 2);
});
