// The relations held for a graph kept as text name nodes by variable, so
// they follow what is done to those nodes (REV-FIX5 L3, REV-W2B-OPENS M2):
// a node deleted takes the relations naming it along, a node renamed keeps
// them under its new name, and the repair on open renames them with a
// renumbered node only where no other node keeps the old name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseUmrFile } from '../src/domain/format/umrFile.js';
import { planImport } from '../src/domain/umrImport.js';
import { UmrDocument } from '../src/domain/UmrDocument.js';
import { rawFromPlan } from './rawFromPlan.js';
import { recordingClient } from './recordingClient.js';
import { layersOf, mergeSentence } from './igtEdits.js';

const SEP = '#'.repeat(80);
const block = (n, words, graph, alignment, doc = `(s${n}s0 / sentence)`) => `${SEP}
# :: snt${n}
Index: ${words.map((_, i) => i + 1).join(' ')}
Words: ${words.join(' ')}

# sentence level graph:
${graph}

# alignment:
${alignment}

# document level annotation:
${doc}
`;

// Sentence 4's graph does not parse (an unterminated string), so it is kept
// as text and its block's relations are held by name.
const TEXT = [
  block(1, ['Ali', 'geldi', '.'], '(s1g / gel-01\n    :ARG1 (s1a / person))', 's1g: 2-2\ns1a: 1-1'),
  block(
    2,
    ['Ayse', 'gitti', '.'],
    '(s2g / git-01\n    :ARG1 (s2p / person))',
    's2g: 2-2\ns2p: 1-1',
  ),
  block(3, ['Can', 'kaldi', '.'], '(s3g / kal-01\n    :ARG1 (s3p / person))', 's3g: 2-2\ns3p: 1-1'),
  block(
    4,
    ['O', 'uyudu', '.'],
    '(s4g / uyu-01\n    :ARG1 (s4x / "person)',
    's4g: 2-2',
    '(s4s0 / sentence\n    :coref ((s4x :same-entity s3p)\n        (s4x :subset-of s2p)))',
  ),
].join('\n');

const rawOf = () => rawFromPlan(planImport(parseUmrFile(TEXT).sentences, []));

const open = (raw) => {
  const { client, calls, requests } = recordingClient();
  const doc = new UmrDocument({ raw, client });
  doc._reload = async () => {};
  doc.onError = (msg) => {
    throw new Error(msg);
  };
  return { doc, calls, requests };
};

const byVar = (doc, v) => [...doc.graph.nodesById.values()].find((n) => n.var === v);
const held = (doc) => doc.sentence(4).held.map((h) => `${h.source} ${h.rel} ${h.target}`);
const heldPatches = (calls) =>
  calls
    .filter((c) => c.name === 'tokens.patchMetadata')
    .map((c) => c.args[1].find((op) => op.path[1] === 'held'));

test('a node deleted takes the held relations naming it along, in the same batch', async () => {
  const { doc, calls } = open(rawOf());
  assert.deepEqual(held(doc), ['s4x :same-entity s3p', 's4x :subset-of s2p']);
  assert.ok(await doc.deleteNode(byVar(doc, 's2p').id));
  await doc.whenSaved();
  assert.deepEqual(held(doc), ['s4x :same-entity s3p']);
  assert.deepEqual(heldPatches(calls), [
    {
      op: 'set',
      path: ['umr', 'held'],
      value: [{ source: 's4x', rel: ':same-entity', target: 's3p', group: 'coref' }],
    },
  ]);
  // IGT then joins sentence 2 to sentence 1, so sentence 3's person reads
  // as s2p after the open's renumber. The relation deleted with the old s2p
  // does not come back naming it.
  const raw = structuredClone(doc.raw);
  mergeSentence(raw, 2);
  const after = open(raw);
  const result = await after.doc._reconcile();
  assert.ok(result.renumbered > 0);
  assert.deepEqual(heldPatches(after.calls), [
    {
      op: 'set',
      path: ['umr', 'held'],
      value: [{ source: 's4x', rel: ':same-entity', target: 's2p', group: 'coref' }],
    },
  ]);
});

test('a node renamed keeps the held relations naming it, under its new name', async () => {
  const { doc, calls, requests } = open(rawOf());
  assert.ok(await doc.setVariable(byVar(doc, 's2p').id, 's2w'));
  await doc.whenSaved();
  assert.deepEqual(held(doc), ['s4x :same-entity s3p', 's4x :subset-of s2w']);
  assert.equal(heldPatches(calls).length, 1);
  assert.equal(requests.filter((r) => r.name !== 'operation').length, 1, 'one request');
});

test('a node deleted in Text mode takes the held relations naming it along', async () => {
  const { doc } = open(rawOf());
  assert.ok((await doc.applyPenman(2, '(s2g / git-01)')) > 0);
  await doc.whenSaved();
  assert.deepEqual(held(doc), ['s4x :same-entity s3p']);
});

test('the open leaves a held name that a node keeping its own still has', async () => {
  // An older writer left sentence 1's person under s2p, the name sentence
  // 2's person has. The open renumbers sentence 1's to s1a2, and the held
  // relation may name either, so it is left naming s2p.
  const raw = rawOf();
  const person = layersOf(raw).concepts.spans.find((s) => s.metadata.umr.var === 's1a');
  person.metadata.umr.var = 's2p';
  const { doc, calls } = open(raw);
  const result = await doc._reconcile();
  assert.equal(result.renumbered, 1);
  assert.deepEqual(heldPatches(calls), []);
  assert.deepEqual(held(open(structuredClone(doc.raw)).doc), [
    's4x :same-entity s3p',
    's4x :subset-of s2p',
  ]);
});

// A relation naming a node no node has or stores and no kept graph defines
// names nothing, and the open drops it before a renumber can give its name
// to another node (REV-FIX7 L1, L2).
test('the open drops a held relation naming a node an edge deleted, before a renumber takes the name', async () => {
  const { doc } = open(rawOf());
  const edge = byVar(doc, 's2g').out.find((e) => e.target === byVar(doc, 's2p').id);
  assert.equal(await doc.deleteEdge(edge.id), 1);
  await doc.whenSaved();
  const raw = structuredClone(doc.raw);
  mergeSentence(raw, 2);
  const after = open(raw);
  const result = await after.doc._reconcile();
  assert.ok(result.renumbered > 0);
  assert.deepEqual(heldPatches(after.calls), [
    {
      op: 'set',
      path: ['umr', 'held'],
      value: [{ source: 's4x', rel: ':same-entity', target: 's2p', group: 'coref' }],
    },
  ]);
});

test('the open drops a held relation naming a node another writer deleted, and keeps one naming a constant', async () => {
  // An API writer (the assistant's delete_node) deletes sentence 2's person
  // and leaves the held relation naming it.
  const raw = rawOf();
  const { concepts, relations } = layersOf(raw);
  const gone = concepts.spans.find((s) => s.metadata?.umr?.var === 's2p').id;
  concepts.spans = concepts.spans.filter((s) => s.id !== gone);
  relations.relations = relations.relations.filter((r) => r.source !== gone && r.target !== gone);
  const record = layersOf(raw).nodes.tokens.find((t) => t.metadata?.umr?.held?.length);
  const constant = {
    source: 's4g',
    rel: ':before',
    target: 'document-creation-time',
    group: 'temporal',
  };
  record.metadata.umr.held.push(constant);
  mergeSentence(raw, 2);
  const after = open(raw);
  const result = await after.doc._reconcile();
  assert.ok(result.renumbered > 0);
  assert.deepEqual(heldPatches(after.calls), [
    {
      op: 'set',
      path: ['umr', 'held'],
      value: [{ source: 's4x', rel: ':same-entity', target: 's2p', group: 'coref' }, constant],
    },
  ]);
});
