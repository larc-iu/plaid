// Text mode: a PENMAN text diffed against the stored graph and applied as
// one operation. Against the recording client, then read back through a
// fake reload built from the recorded writes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyMetadataOps } from '@larc-iu/plaid-client';
import { parseUmrFile } from '../src/domain/format/umrFile.js';
import { planImport } from '../src/domain/umrImport.js';
import { UmrDocument } from '../src/domain/UmrDocument.js';
import { rawFromPlan } from './rawFromPlan.js';
import { recordingClient } from './recordingClient.js';

const FILE = `################################################################################
# :: snt1	Lindsay left in order to eat lunch .
Index: 1 2 3 4 5 6 7 8
Words: Lindsay left in order to eat lunch .

# sentence level graph:
(s1l / leave-02
    :ARG0 (s1p / person
        :name (s1n / name :op1 "Lindsay"))
    :aspect performance
    :purpose (s1e / eat-01 :ARG0 s1p :aspect performance))

# alignment:
s1l: 2-2
s1p: 1-1
s1n: 0-0
s1e: 6-6

# document level annotation:


`;

const load = () => {
  const plan = planImport(parseUmrFile(FILE).sentences, []);
  const { client, calls, requests } = recordingClient();
  const doc = new UmrDocument({ raw: rawFromPlan(plan), client });
  // The reload after apply is stubbed: the writes are what is checked.
  doc._reload = async () => {};
  doc.onError = (msg) => {
    throw new Error(msg);
  };
  return { doc, calls, requests };
};

// The ops of one kind, whichever pass carried them: a bulk create is one
// call holding many.
const opsOf = (calls, name) => calls.filter((c) => c.name === name).flatMap((c) => c.args[0]);
const patches = (calls, name) =>
  calls.filter((c) => c.name === name).map((c) => ({ id: c.args[0], patch: c.args[1] }));
const has = (ops, op, path, value) =>
  ops.some(
    (o) =>
      o.op === op &&
      JSON.stringify(o.path) === JSON.stringify(path) &&
      (op === 'delete' || o.value === value),
  );
const nodeId = (doc, v) => [...doc.graph.nodesById.values()].find((n) => n.var === v).id;

test('penmanOf writes the sentence back as PENMAN', () => {
  const { doc } = load();
  const text = doc.penmanOf(1);
  assert.match(text, /^\(s1l \/ leave-02/);
  assert.match(text, /:purpose \(s1e \/ eat-01/);
});

test('planPenman sees no change in the sentence as written', () => {
  const { doc } = load();
  const plan = doc.planPenman(1, doc.penmanOf(1));
  assert.equal(plan.changes, 0);
});

test('planPenman reports a parse error rather than a plan', () => {
  const { doc } = load();
  const plan = doc.planPenman(1, '(s1l / leave-02 :ARG0 (s1p / person');
  assert.ok(plan.errors?.length);
});

test('applyPenman adds a node with its edge, changes a concept and an attribute, drops an edge', async () => {
  const { doc, calls } = load();
  const text = `(s1l / leave-02
    :ARG0 (s1p / person
        :name (s1n / name :op1 "Lindsay"))
    :aspect performance
    :purpose (s1e / eat-01 :ARG0 s1p :ARG1 (s1l2 / lunch) :aspect state))`;
  const plan = doc.planPenman(1, text);
  assert.equal(plan.create.length, 1);
  assert.equal(plan.create[0].var, 's1l2');
  assert.equal(plan.attrs.length, 1);
  assert.equal(plan.edgesAdd.length, 1);
  assert.equal(plan.edgesDelete.length, 0);
  const changes = await doc.applyPenman(1, text);
  assert.equal(changes, 3);
  assert.deepEqual(
    calls.map((c) => c.name),
    [
      'operation',
      'spans.patchMetadata',
      'tokens.bulkCreate',
      'spans.bulkCreate',
      'relations.bulkCreate',
    ],
  );
  // The new node is aligned to no word, so it stands over its whole sentence
  // and records it (umrReconcile.js).
  const [anchor] = opsOf(calls, 'tokens.bulkCreate');
  assert.equal(anchor.begin, doc.sentence(1).begin);
  assert.equal(anchor.end, doc.sentence(1).end);
  assert.deepEqual(
    opsOf(calls, 'spans.bulkCreate').map((o) => o.value),
    ['lunch'],
  );
  assert.deepEqual(
    opsOf(calls, 'relations.bulkCreate').map((o) => o.value),
    [':ARG1'],
  );
  assert.match(calls[0].args[0], /3 changes/);
});

test('an edge into a deleted node is left to the cascade, not deleted twice', async () => {
  const { doc, calls } = load();
  const text = `(s1e / eat-01 :ARG0 (s1p / person) :aspect performance)`;
  const plan = doc.planPenman(1, text);
  // s1l and s1n go; the :name edge into s1n and the :purpose edge out of s1l
  // go with them, so nothing is deleted by id.
  assert.equal(plan.edgesDelete.length, 0);
  await doc.applyPenman(1, text);
  assert.ok(!calls.some((c) => c.name === 'relations.delete'));
});

test("a fragment the text never showed is not the text's to delete", async () => {
  const { doc } = load();
  const r = await doc.createNode({ sentenceIndex: 1, concept: 'thing' });
  assert.ok(r);
  const text = doc.penmanOf(1);
  assert.doesNotMatch(text, /thing/);
  assert.equal(doc.planPenman(1, text).changes, 0);
});

test('re-rooting onto a node the text creates clears the old mark first', async () => {
  const { doc, calls } = load();
  const text = `(s1x / say-01
    :ARG1 (s1l / leave-02
        :ARG0 (s1p / person
            :name (s1n / name :op1 "Lindsay"))
        :aspect performance
        :purpose (s1e / eat-01 :ARG0 s1p :aspect performance)))`;
  const plan = doc.planPenman(1, text);
  assert.equal(plan.root, 's1x');
  await doc.applyPenman(1, text);
  const names = calls.map((c) => c.name);
  const [unmark] = patches(calls, 'spans.patchMetadata');
  assert.ok(unmark, 'the old root loses its mark');
  assert.ok(has(unmark.patch, 'delete', ['umr', 'root']));
  assert.ok(names.indexOf('spans.patchMetadata') < names.indexOf('spans.bulkCreate'));
  const [created] = opsOf(calls, 'spans.bulkCreate');
  assert.equal(created.metadata.umr.root, true);
});

test('applyPenman deletes a node the text no longer has and re-roots', async () => {
  const { doc, calls } = load();
  const text = `(s1e / eat-01 :ARG0 (s1p / person) :aspect performance)`;
  const plan = doc.planPenman(1, text);
  assert.deepEqual(plan.delete.length, 2);
  assert.equal(plan.root, 's1e');
  const oldRoot = nodeId(doc, 's1l');
  await doc.applyPenman(1, text);
  assert.ok(calls.some((c) => c.name === 'tokens.bulkDelete'));
  const rootPatches = patches(calls, 'spans.patchMetadata');
  assert.ok(rootPatches.some((p) => has(p.patch, 'set', ['umr', 'root'], true)));
  // The old root was deleted with its subtree, so no mark to clear.
  assert.ok(!rootPatches.some((p) => p.id === oldRoot && has(p.patch, 'delete', ['umr', 'root'])));
});

// When every metadata patch replaced the umr namespace whole, one built from
// the state read before any write put the old root's mark back (two roots),
// and the new root's mark reverted its attribute change. Each patch now sets
// only the keys it changes.
test('moving the root and changing either root attribute keeps both changes', async () => {
  const { doc, calls } = load();
  const text = `(s1e / eat-01
    :ARG0 (s1p / person
        :name (s1n / name :op1 "Lindsay"))
    :aspect activity
    :purpose-of (s1l / leave-02 :ARG0 s1p :aspect state))`;
  const before = new Map([...doc.graph.nodesById.values()].map((n) => [n.id, n.metadata]));
  await doc.applyPenman(1, text);
  // Each span's metadata once every patch of the batch has landed, in order.
  const last = new Map();
  patches(calls, 'spans.patchMetadata').forEach(({ id, patch }) =>
    last.set(id, applyMetadataOps(last.get(id) ?? before.get(id), patch)),
  );
  const byVar = (v) => [...last.values()].map((m) => m.umr).find((m) => m.var === v);
  assert.equal(byVar('s1l').root, undefined);
  assert.deepEqual(
    byVar('s1l').attrs.map((a) => a.value),
    ['state'],
  );
  assert.equal(byVar('s1e').root, true);
  assert.deepEqual(
    byVar('s1e').attrs.map((a) => a.value),
    ['activity'],
  );
});

test('an attribute moved past an edge is stored where it was moved', async () => {
  const { doc } = load();
  const text = doc.penmanOf(1).replace(
    `    :aspect performance
    :purpose`,
    `    :purpose`,
  );
  const moved = text.replace(
    ':aspect performance))',
    ':aspect performance)\n    :aspect performance)',
  );
  const plan = doc.planPenman(1, moved);
  assert.equal(plan.attrs.length, 1);
  assert.deepEqual(
    plan.attrs[0].attrs.map((a) => [a.rel, a.order]),
    [[':aspect', 2]],
  );
});

// What the canvas refuses, text mode refuses: a variable taken or malformed,
// and a new edge that closes a cycle.
test('text mode refuses what the canvas refuses', () => {
  const { doc } = load();
  const base = doc.penmanOf(1);
  const withChild = (child) => base.replace(':ARG0 s1p', `:ARG0 s1p\n        :ARG1 ${child}`);
  assert.match(
    doc.planPenman(1, withChild('(x / thing)')).errors[0].message,
    /x is not a variable/,
  );
  assert.match(
    doc.planPenman(1, withChild('(s1l2 / thing :mod s1l)')).errors[0].message,
    /would close a cycle/,
  );
  assert.equal(doc.planPenman(1, withChild('(s1l2 / thing)')).errors, undefined);
});

// A variable typed over is the same node under a new name: it keeps its
// anchor, its edges and its document-level relations.
test('a variable typed over is read as a rename', () => {
  const { doc } = load();
  const plan = doc.planPenman(1, doc.penmanOf(1).replaceAll('s1l', 's1g'));
  assert.deepEqual(plan.rename, [
    { nodeId: doc.sentence(1).nodes.find((n) => n.var === 's1l').id, from: 's1l', to: 's1g' },
  ]);
  assert.deepEqual(plan.delete, []);
  assert.deepEqual(plan.create, []);
  assert.deepEqual(plan.losses, []);
  assert.deepEqual(plan.edgesAdd, []);
  assert.deepEqual(plan.edgesDelete, []);
  assert.equal(plan.changes, 1);
  // A child renamed the same way keeps the edge into it, too.
  const child = doc.planPenman(1, doc.penmanOf(1).replaceAll('s1e', 's1x'));
  assert.equal(child.rename.length, 1);
  assert.deepEqual(
    [child.delete, child.create, child.edgesAdd, child.edgesDelete],
    [[], [], [], []],
  );
});

// Anything less clear-cut is what it was: a node gone and a node arrived,
// and the plan says what the old one takes with it.
test('the plan names what a deletion takes that the text does not show', () => {
  const { doc } = load();
  // The concept changed as well, so the two are not plainly the same node.
  const plan = doc.planPenman(1, doc.penmanOf(1).replace('s1l / leave-02', 's1g / depart-01'));
  assert.deepEqual(plan.rename, []);
  assert.deepEqual(plan.losses, [{ var: 's1l', anchored: true, relations: 0 }]);
  // Two variables typed over at once: no telling which became which.
  const two = doc.planPenman(1, doc.penmanOf(1).replaceAll('s1l', 's1g').replaceAll('s1e', 's1x'));
  assert.deepEqual(two.rename, []);
  assert.deepEqual(two.losses.map((l) => l.var).sort(), ['s1e', 's1l']);
});

// The cost of an Apply. It used to be about three round trips per node, in
// series, holding the document's write lock: a graph pasted from another
// tool took seconds with "applying" on screen. Three batches now, whatever
// the graph's size.
test('a 30-node apply is three requests, not ninety', async () => {
  const { doc, calls, requests } = load();
  const children = Array.from(
    { length: 30 },
    (_, i) => `    :ARG${i} (s1t${i} / thing-${i} :refer-number singular)`,
  ).join('\n');
  const text = `(s1l / leave-02\n${children})`;
  const plan = doc.planPenman(1, text);
  assert.equal(plan.create.length, 30);
  assert.ok(plan.delete.length >= 3, 'the old children go');
  assert.equal(await doc.applyPenman(1, text), plan.changes);
  assert.deepEqual(
    requests.map((r) => r.name),
    ['batch', 'batch', 'batch'],
  );
  // One anchor, one node and one edge per new node, carried by those three.
  assert.equal(opsOf(calls, 'tokens.bulkCreate').length, 30);
  assert.equal(opsOf(calls, 'spans.bulkCreate').length, 30);
  assert.equal(opsOf(calls, 'relations.bulkCreate').length, 30);
});

test('an apply that makes nothing new is one request', async () => {
  const { doc, requests } = load();
  const text = doc.penmanOf(1).replace('leave-02', 'depart-01').replace('s1l /', 's1l /');
  const plan = doc.planPenman(1, text);
  assert.ok(plan.changes > 0);
  assert.equal(await doc.applyPenman(1, text), plan.changes);
  assert.deepEqual(
    requests.map((r) => r.name),
    ['batch'],
  );
});
