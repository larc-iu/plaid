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

// Text mode shows every node of the sentence: a part the root does not
// reach is a graph of its own after the root's, so the text round-trips,
// and one left out of the text is deleted like any other node.
test('a loose node is in the text as a graph of its own, and goes when left out', async () => {
  const { doc } = load();
  const r = await doc.createNode({ sentenceIndex: 1, concept: 'thing' });
  assert.ok(r);
  const text = doc.penmanOf(1);
  const [rootGraph, loose] = text.split('\n\n');
  assert.match(rootGraph, /^\(s1l \/ leave-02/);
  assert.match(loose, /^\(s1t \/ thing\)$/);
  assert.equal(doc.planPenman(1, text).changes, 0);
  const without = doc.planPenman(1, rootGraph);
  assert.deepEqual(
    without.delete.map((id) => doc.node(id).var),
    ['s1t'],
  );
});

test('a fragment with a child, and a new loose node typed as its own graph', async () => {
  const { doc } = load();
  const text = `${doc.penmanOf(1)}

(s1t / thing
    :mod (s1b / big))

(s1q / quick)`;
  const plan = doc.planPenman(1, text);
  assert.equal(plan.errors, undefined);
  assert.deepEqual(plan.create.map((c) => c.var).sort(), ['s1b', 's1q', 's1t']);
  assert.equal(plan.root, null);
  assert.deepEqual(plan.delete, []);
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
  // A role UMR does not have is refused, as the canvas's role editor does, not
  // stored and then reported. A concept stays free text.
  assert.match(
    doc.planPenman(1, base.replace(':ARG0 s1p', ':poss s1p')).errors[0].message,
    /s1e: Unknown relation ':poss': UMR 2\.0 renamed it :possessor\./,
  );
  assert.match(
    doc.planPenman(1, base.replace(':aspect performance)', ':colour red)')).errors[0].message,
    /Unknown relation ':colour'/,
  );
  assert.equal(doc.planPenman(1, base.replace(':ARG0 s1p', ':ARG0-of s1p')).errors, undefined);
  assert.equal(doc.planPenman(1, withChild('(s1l2 / wholly-new-concept)')).errors, undefined);
});

// A graph imported with a relation UMR does not have can still be edited in
// text mode: only a relation the text brings in is refused.
test('a stored unknown relation does not block text mode', async () => {
  const plan = planImport(
    parseUmrFile(FILE.replace(':ARG0 s1p :aspect', ':poss s1p :aspect')).sentences,
    [],
  );
  const { client } = recordingClient();
  const doc = new UmrDocument({ raw: rawFromPlan(plan), client });
  const text = doc.penmanOf(1);
  assert.match(text, /:poss s1p/);
  const edited = text.replace('leave-02', 'leave-01');
  assert.equal(doc.planPenman(1, edited).errors, undefined);
  assert.equal(doc.planPenman(1, edited).concept.length, 1);
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

// A node with an edge to itself (`:quote`, which the canvas makes) names
// itself as a parent, under the old name in the store and the new one in
// the text. That is still the same node: a rename, keeping its anchor, its
// edges, the edge to itself and its document-level relations.
test('a variable typed over on a node with an edge to itself is a rename', async () => {
  const file = FILE.replace(':aspect performance\n    :purpose', ':quote s1l\n    :purpose')
    .replace(':ARG0 s1p :aspect performance)', ':ARG0 s1p :quote s1e)')
    .replace(
      '# document level annotation:\n',
      '# document level annotation:\n(s1s0 / sentence :modal ((author :full-affirmative s1l)))\n',
    );
  const { client, calls } = recordingClient();
  const doc = new UmrDocument({
    raw: rawFromPlan(planImport(parseUmrFile(file).sentences, [])),
    client,
  });
  doc._reload = async () => {};
  doc.onError = (msg) => {
    throw new Error(msg);
  };
  const text = doc.penmanOf(1);
  assert.match(text, /:quote s1l/);
  assert.match(text, /:quote s1e/);
  for (const [from, to] of [
    ['s1l', 's1g'],
    ['s1e', 's1x'],
  ]) {
    const plan = doc.planPenman(1, text.replaceAll(from, to));
    assert.deepEqual(plan.rename, [{ nodeId: nodeId(doc, from), from, to }]);
    assert.deepEqual(
      [plan.delete, plan.create, plan.edgesAdd, plan.edgesDelete, plan.losses],
      [[], [], [], [], []],
    );
  }
  // Applied, the rename writes the new name and deletes nothing.
  const leave = nodeId(doc, 's1l');
  assert.equal(await doc.applyPenman(1, text.replaceAll('s1l', 's1g')), 1);
  assert.deepEqual(
    calls.filter((c) => /delete/i.test(c.name)),
    [],
  );
  assert.ok(
    calls.some((c) => c.name === 'spans.patchMetadata' && c.args[0] === leave),
    'the new name is written on the node',
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
// tool took seconds with "applying" on screen. One batch now, the nodes and
// edges naming what it makes by ref (textModeOneBatch.test.js).
test('a 30-node apply is one request, not ninety', async () => {
  const { doc, calls, requests } = load();
  const children = Array.from(
    { length: 30 },
    (_, i) => `    :op${i + 1} (s1t${i} / thing-${i} :refer-number singular)`,
  ).join('\n');
  const text = `(s1l / leave-02\n${children})`;
  const plan = doc.planPenman(1, text);
  assert.equal(plan.create.length, 30);
  assert.ok(plan.delete.length >= 3, 'the old children go');
  assert.equal(await doc.applyPenman(1, text), plan.changes);
  assert.deepEqual(
    requests.map((r) => r.name),
    ['batch'],
  );
  // One anchor, one node and one edge per new node, carried by it.
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

// The document refuses a relation UMR does not have on every write, not only
// where a screen asks first. One stored at the very place written (an
// imported file's) is kept, and one stored on another node or edge is not.
test('every write refuses an unknown relation, keeping one stored at that place', async () => {
  const file = FILE.replace(':ARG0 s1p :aspect', ':poss s1p :aspect').replace(
    ':aspect performance\n    :purpose',
    ':aspect performance\n    :colour red\n    :purpose',
  );
  const { client, calls } = recordingClient();
  const doc = new UmrDocument({
    raw: rawFromPlan(planImport(parseUmrFile(file).sentences, [])),
    client,
  });
  let refused = null;
  doc.onError = (msg) => {
    refused = msg;
  };
  const node = (v) => doc.node(nodeId(doc, v));
  const leave = node('s1l');
  const eat = node('s1e');
  const poss = eat.out.find((e) => e.role === ':poss');
  const arg0 = leave.out.find((e) => e.role === ':ARG0');
  assert.ok(poss && arg0 && leave.attrs.some((a) => a.rel === ':colour'));

  assert.equal(doc.relationProblem(':poss', { edgeId: poss.id }), null);
  const renamed = "Unknown relation ':poss': UMR 2.0 renamed it :possessor.";
  assert.equal(doc.relationProblem('poss', { edgeId: arg0.id }), renamed);
  assert.equal(doc.relationProblem(':poss'), renamed);
  assert.equal(doc.relationProblem(':colour', { nodeId: leave.id }), null);
  assert.equal(doc.relationProblem(':colour', { nodeId: eat.id }), "Unknown relation ':colour'.");
  assert.match(doc.relationProblem(':a b'), /letters, digits and hyphens only/);
  assert.equal(doc.relationProblem(':ARG1-of'), null);
  assert.equal(doc.relationProblem(':before', { group: 'temporal' }), null);
  assert.match(doc.relationProblem(':poss', { group: 'temporal' }), /Unknown document-level/);

  const refuses = async (write, why) => {
    doc.setError(null);
    refused = null;
    const before = calls.length;
    assert.equal(await write(), false);
    assert.match(refused, why);
    assert.equal(calls.length, before);
  };
  const unknown = /Unknown relation/;
  await refuses(
    () => doc.setAttrs(eat.id, [...eat.attrs, { rel: ':colour', value: 'red' }]),
    unknown,
  );
  await refuses(() => doc.setAttrs(eat.id, [{ rel: ':mod', value: 'a"b' }]), /quote/);
  await refuses(() => doc.setRole(arg0.id, ':poss'), unknown);
  await refuses(() => doc.createEdge(leave.id, node('s1n').id, ':poss'), unknown);
  await refuses(
    () => doc.createNode({ sentenceIndex: 1, concept: 'thing', parentId: leave.id, role: ':poss' }),
    unknown,
  );
  await refuses(
    () =>
      doc.createNode({
        sentenceIndex: 1,
        concept: 'thing',
        attrs: [{ rel: ':colour', value: 'x' }],
      }),
    unknown,
  );
  await refuses(
    () => doc.createTriple({ source: leave.id, target: eat.id, rel: ':poss', group: 'temporal' }),
    /Unknown document-level temporal relation/,
  );
  const triple = await doc.createTriple({
    source: leave.id,
    target: eat.id,
    rel: ':before',
    group: 'temporal',
  });
  assert.ok(triple);
  await refuses(() => doc.setTripleRelation(triple, ':poss'), /Unknown document-level/);

  // The node's own unknown attribute is kept through an edit of the others.
  refused = null;
  assert.ok(
    await doc.setAttrs(leave.id, [
      ...leave.attrs.filter((a) => a.rel !== ':aspect'),
      { rel: ':aspect', value: 'state' },
    ]),
  );
  assert.equal(refused, null);
});

// Ruling 1 of round 4: text mode keeps a stored unknown relation on the node
// or edge that holds it, as the canvas does, and nowhere else. It once kept
// it anywhere in the sentence, so a new :poss edge passed because another
// node had one.
test('text mode keeps a stored unknown relation only where it is stored', () => {
  const file = FILE.replace(':ARG0 s1p :aspect', ':poss s1p :aspect').replace(
    ':aspect performance\n    :purpose',
    ':aspect performance\n    :colour red\n    :purpose',
  );
  const { client } = recordingClient();
  const doc = new UmrDocument({
    raw: rawFromPlan(planImport(parseUmrFile(file).sentences, [])),
    client,
  });
  const text = doc.penmanOf(1);
  assert.match(text, /:poss s1p/);
  assert.match(text, /:colour red/);
  const plan = (edited) => doc.planPenman(1, edited);
  // Kept where stored: the edge and the attribute stay, the value may change,
  // and a rename keeps the node's own.
  assert.equal(plan(text.replace('leave-02', 'leave-01')).errors, undefined);
  assert.equal(plan(text.replace(':colour red', ':colour blue')).errors, undefined);
  assert.equal(plan(text.replaceAll('s1l', 's1l9')).errors, undefined);
  // The target of the stored :poss edge renamed, the mirror of the assistant's
  // test_a_renamed_variable_keeps_what_its_node_and_edges_hold.
  assert.equal(plan(text.replaceAll('s1p', 's1p9')).rename[0].to, 's1p9');
  assert.equal(plan(text.replaceAll('s1p', 's1p9')).errors, undefined);
  // A new node, another node, or another edge does not share the exemption.
  assert.match(
    plan(text.replace(':poss s1p', ':poss s1p :ARG1 (s1x / thing :poss s1p)')).errors[0].message,
    /s1x: Unknown relation ':poss'/,
  );
  assert.match(
    plan(text.replace('"Lindsay")', '"Lindsay" :colour red)')).errors[0].message,
    /s1n: Unknown relation ':colour'/,
  );
  assert.match(
    plan(text.replace(':poss s1p', ':poss s1n')).errors[0].message,
    /s1e: Unknown relation ':poss'/,
  );
});

// A value the file stores that the editors would not let anyone type (a quote
// inside a bare atom) is kept where it is stored, as a stored unknown relation
// is. It once refused every row pick on that node, on any row.
test('a stored value no editor would take is kept on its node, and nowhere else', async () => {
  const file = FILE.replace(
    ':aspect performance\n    :purpose',
    ':aspect performance\n    :mod re"d\n    :purpose',
  );
  const { client, calls } = recordingClient();
  const doc = new UmrDocument({
    raw: rawFromPlan(planImport(parseUmrFile(file).sentences, [])),
    client,
  });
  doc._reload = async () => {};
  let refused = null;
  doc.onError = (msg) => {
    refused = msg;
  };
  const leave = doc.node(nodeId(doc, 's1l'));
  const eat = doc.node(nodeId(doc, 's1e'));
  assert.ok(leave.attrs.some((a) => a.rel === ':mod' && a.value === 're"d'));

  assert.equal(doc.attrValueProblem(':mod', 're"d', { nodeId: leave.id }), null);
  assert.match(doc.attrValueProblem(':mod', 're"d', { nodeId: eat.id }), /quote/);
  assert.match(doc.attrValueProblem(':mod', 're"d'), /quote/);
  assert.match(doc.attrValueProblem(':quant', 're"d', { nodeId: leave.id }), /quote/);
  assert.match(doc.attrValueProblem(':mod', 'b"c', { nodeId: leave.id }), /quote/);

  // A pick on another row sends the stored value back, and is written.
  assert.ok(await doc.setAttrs(leave.id, [...leave.attrs, { rel: ':polarity', value: '-' }]));
  assert.equal(refused, null);
  const before = calls.length;
  assert.equal(await doc.setAttrs(eat.id, [...eat.attrs, { rel: ':mod', value: 're"d' }]), false);
  assert.match(refused, /quote/);
  assert.equal(calls.length, before);

  // Text mode keeps it where it is stored too.
  const text = doc.penmanOf(1);
  assert.match(text, /:mod re"d/);
  assert.equal(doc.planPenman(1, text.replace('leave-02', 'leave-01')).errors, undefined);
  assert.match(
    doc.planPenman(1, text.replace('eat-01', 'eat-01 :mod re"d')).errors[0].message,
    /s1e: .*quote/,
  );
});
