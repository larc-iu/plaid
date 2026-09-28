// Three limits on what reconcile on open and Text mode do after IGT changes
// the sentences (the defaults adopted with the rulings of 2026-09-28):
//
// - Renumbering leaves alone a document whose stored `snt` numbers do not
//   run 1, 2, 3: a released excerpt starting at `# :: snt5` keeps its names.
//   A sentence IGT added stores no number and is passed over.
// - Mending a graph kept as text accepts that graph's own names even when IGT
//   has shifted the sentences since. The next open renumbers them.
// - A sentence with no words at all (IGT's "Clear tokens", before it tokenizes
//   again) is a tokenization in progress, and its nodes keep their anchors.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseUmrFile } from '../src/domain/format/umrFile.js';
import { planImport } from '../src/domain/umrImport.js';
import { UmrDocument } from '../src/domain/UmrDocument.js';
import { planRenumber } from '../src/domain/umrReconcile.js';
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

// ----- 1. renumbering and the stored sentence numbers -----

test('an excerpt whose file starts at snt5 keeps its variables on first open', async () => {
  const { doc, calls } = open(fromText(`${block(5)}\n${block(6)}`));
  assert.deepEqual(vars(doc), ['s5a', 's5g', 's6a', 's6g']);
  assert.deepEqual(planRenumber(doc.graph), []);
  assert.deepEqual(await doc._reconcile(), { findings: [] });
  assert.equal(calls.length, 0);
});

test('the same file starting at snt1 with a sentence IGT added before it is renumbered', async () => {
  const raw = fromText(`${block(1)}\n${block(2)}`);
  insertSentenceAtStart(raw);
  const { doc } = open(raw);
  const result = await doc._reconcile();
  assert.equal(result.renumbered, 4);
  assert.equal(
    doc.describeReconcile(result),
    'Repaired: renumbered 4 variables to match the sentences',
  );
});

test('numbers that skip one, as a sentence deleted in IGT leaves them, stop renumbering', () => {
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
  assert.deepEqual(vars(doc), ['s1a', 's1g', 's3a', 's3g']);
  assert.deepEqual(planRenumber(doc.graph), []);
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
  // The next open renumbers the mended nodes with the rest.
  const renumber = planRenumber(doc.graph);
  const moved = new Map(renumber.map((r) => [r.from, r.to]));
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
  assert.deepEqual(await doc._reconcile(), { findings: [] });
  assert.equal(calls.length, 0);
  // Tokenized again, the nodes are aligned as they were.
  role(raw, 'word').tokens = words;
  const { doc: again } = open(raw);
  assert.ok(again.sentence(2).nodes.every((n) => n.aligned));
});

test('a sentence that keeps some words still unanchors a node whose word went', async () => {
  const raw = fromText(`${block(1)}\n${block(2)}`);
  const body = raw.textLayers[0].text.body;
  const at = body.indexOf('Ali', role(raw, 'sentence').tokens[1].begin);
  role(raw, 'word').tokens = role(raw, 'word').tokens.filter((t) => t.begin !== at);
  const { doc } = open(raw);
  const result = await doc._reconcile();
  assert.deepEqual(result.unanchored, ['s2a']);
});

// ----- 4. the vocabulary read -----

test('an open reads the vocabularies only when a node names an entry', async () => {
  const raw = fromText(`${block(1)}`);
  const { client } = recordingClient();
  const asked = [];
  client.vocabLayers = { get: async (id) => (asked.push(id), { id, items: [] }) };
  const doc = new UmrDocument({ raw, client, project: { vocabs: [{ id: 'v1' }] } });
  doc._reload = async () => {};
  assert.deepEqual(await doc._reconcile(), { findings: [] });
  assert.deepEqual(asked, [], 'no node names an entry, so nothing is read');
  const node = [...doc.graph.nodesById.values()][0];
  node.metadata.umr.entry = 'gone';
  const picked = new UmrDocument({ raw, client, project: { vocabs: [{ id: 'v1' }] } });
  picked._reload = async () => {};
  client.spans.patchMetadata = async () => {};
  const result = await picked._reconcile();
  assert.deepEqual(asked, ['v1']);
  assert.equal(result.unlinked, 1);
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
  const name = [...doc.graph.nodesById.values()].find((n) => n.var === 's1n');
  assert.equal(name.metadata.umr.sentence, kept);
  // It is read in the sentence its anchor and its parent are in, not the
  // one its record names, so no edge crosses a sentence.
  assert.equal(name.sentence, 2);
  assert.equal(name.aligned, false);
  const result = await doc._reconcile();
  assert.equal(result.rebound, 1);
  const patches = calls.filter((c) => c.name === 'spans.patchMetadata' && c.args[0] === name.id);
  assert.deepEqual(patches[0].args[1], [
    { op: 'set', path: ['umr', 'sentence'], value: 'igt-right' },
    { op: 'set', path: ['umr', 'var'], value: 's2n' },
  ]);
  assert.equal(
    doc.describeReconcile(result),
    'Repaired: rebound 1 unaligned node to the sentence it is in, renumbered 4 variables to match the sentences',
  );
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
