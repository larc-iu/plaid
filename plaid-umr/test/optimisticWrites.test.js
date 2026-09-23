// Every edit shows on the canvas before the server answers, creates included.
// The client here holds every write until the test lets it through, so what
// the document shows in between is what an annotator sees while the round
// trip is in flight.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseUmrFile } from '../src/domain/format/umrFile.js';
import { planImport } from '../src/domain/umrImport.js';
import { UmrDocument } from '../src/domain/UmrDocument.js';
import { isPendingId } from '../../plaid-ui/src/domain/pendingIds.js';
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

// The recording client, with every write held until `release()`. Batches are
// held too, since their ops run through the same methods. `fail` names one
// method (`relations.create`) whose next call is refused.
const open = ({ fail = null } = {}) => {
  const raw = rawFromPlan(planImport(parseUmrFile(FILE).sentences, []));
  const { client, calls } = recordingClient();
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  for (const group of ['tokens', 'spans', 'relations']) {
    for (const [method, fn] of Object.entries(client[group])) {
      client[group][method] = async (...args) => {
        await gate;
        if (fail === `${group}.${method}`) {
          fail = null;
          throw new Error('refused');
        }
        return fn(...args);
      };
    }
  }
  client.documents.get = async () => structuredClone(raw);
  const doc = new UmrDocument({ raw: structuredClone(raw), client });
  const byVar = (v) => [...doc.graph.nodesById.values()].find((n) => n.var === v);
  return { doc, calls, release, byVar };
};

// Let the write run up to its first held call.
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('a new node and its edge show before the server answers, and focus can go to it', async () => {
  const { doc, release, byVar } = open();
  const root = byVar('s1l');
  const word = doc.sentence(1).words[6];
  let shown = null;
  const write = doc.createNode({
    sentenceIndex: 1,
    concept: 'lunch',
    wordIds: [word.id],
    parentId: root.id,
    role: ':ARG1',
    onShown: (ids) => (shown = ids),
  });
  await settle();
  assert.ok(isPendingId(shown.nodeId));
  const node = doc.node(shown.nodeId);
  assert.equal(node.concept, 'lunch');
  assert.deepEqual(node.wordIds, [word.id]);
  assert.equal(node.in[0].source, root.id);

  release();
  const saved = await write;
  assert.ok(!isPendingId(saved.nodeId) && !isPendingId(saved.edgeId));
  assert.equal(doc.node(saved.nodeId).concept, 'lunch');
  // The canvas may still hold the pending id: it finds the same node.
  assert.equal(doc.node(shown.nodeId).id, saved.nodeId);
});

test('an edge drawn, moved and deleted shows each step before the server answers', async () => {
  const { doc, release, byVar } = open();
  const eat = byVar('s1e');
  const name = byVar('s1n');
  const drawn = doc.createEdge(eat.id, name.id, ':ARG1');
  await settle();
  const edge = doc.node(eat.id).out.find((e) => e.target === name.id);
  assert.ok(edge && isPendingId(edge.id));

  const moved = doc.moveEdge(edge.id, byVar('s1l').id);
  await settle();
  assert.ok(doc.node(byVar('s1l').id).out.some((e) => e.target === name.id && e.role === ':ARG1'));
  assert.ok(!doc.node(eat.id).out.some((e) => e.target === name.id));

  const movedEdge = doc.node(byVar('s1l').id).out.find((e) => e.target === name.id);
  const deleted = doc.deleteEdge(movedEdge.id, { subtree: false });
  await settle();
  assert.ok(!doc.node(byVar('s1l').id).out.some((e) => e.target === name.id && e.role === ':ARG1'));

  release();
  assert.ok(await drawn);
  assert.equal(await moved, true);
  assert.equal(await deleted, 0);
});

test('an anchor change and a node deletion show before the server answers', async () => {
  const { doc, release, byVar } = open();
  const eat = byVar('s1e');
  const lunch = doc.sentence(1).words[6];
  const anchored = doc.setAnchor(eat.id, [lunch.id]);
  await settle();
  assert.deepEqual(doc.node(eat.id).wordIds, [lunch.id]);

  const deleted = doc.deleteNode(eat.id, { subtree: false });
  await settle();
  assert.equal(doc.node(eat.id), null);

  release();
  assert.equal(await anchored, true);
  assert.equal(await deleted, true);
  assert.equal(byVar('s1e'), undefined);
});

test('a document-level relation to a new constant shows before the server answers', async () => {
  const { doc, release, byVar } = open();
  const leave = byVar('s1l');
  const write = doc.createTriple({
    source: 'document-creation-time',
    target: leave.id,
    rel: ':before',
  });
  await settle();
  const constant = doc.constantNode('document-creation-time');
  assert.ok(constant && isPendingId(constant.id));
  assert.ok(constant.docOut.some((t) => t.target === leave.id));

  release();
  const id = await write;
  assert.ok(id && !isPendingId(id));
  assert.ok(!isPendingId(doc.constantNode('document-creation-time').id));
});

test('text mode shows the whole plan before the server answers', async () => {
  const { doc, release, byVar } = open();
  const text = doc
    .penmanOf(1)
    .replace(':aspect performance))', ':aspect performance :ARG1 (s1l2 / lunch)))');
  const write = doc.applyPenman(1, text);
  await settle();
  const lunch = byVar('s1l2');
  assert.ok(lunch && isPendingId(lunch.id));
  assert.equal(lunch.in[0].source, byVar('s1e').id);

  release();
  assert.ok((await write) > 0);
  assert.ok(!isPendingId(byVar('s1l2').id));
  assert.equal(byVar('s1l2').in[0].source, byVar('s1e').id);
});

test('an edit of a node still being saved shows at once and is sent under its server id', async () => {
  const { doc, calls, release, byVar } = open();
  let shown = null;
  const made = doc.createNode({
    sentenceIndex: 1,
    concept: 'lunch',
    parentId: byVar('s1e').id,
    role: ':ARG1',
    onShown: (ids) => (shown = ids),
  });
  await settle();
  const renamed = doc.setConcept(shown.nodeId, 'meal');
  assert.equal(doc.node(shown.nodeId).concept, 'meal');

  release();
  const saved = await made;
  assert.equal(await renamed, true);
  const update = calls.find((c) => c.name === 'spans.update');
  assert.equal(update.args[0], saved.nodeId);
  assert.equal(doc.node(saved.nodeId).concept, 'meal');
});

test('a refused write reloads, and the edits queued behind it are not sent', async () => {
  const { doc, calls, release, byVar } = open({ fail: 'relations.create' });
  const eat = byVar('s1e');
  const name = byVar('s1n');
  const drawn = doc.createEdge(eat.id, name.id, ':ARG1');
  await settle();
  const relabelled = doc.setConcept(eat.id, 'dine-01');
  assert.equal(doc.node(eat.id).concept, 'dine-01');

  release();
  assert.equal(await drawn, false);
  assert.equal(await relabelled, false);
  assert.ok(!calls.some((c) => c.name === 'spans.update'));
  assert.equal(byVar('s1e').concept, 'eat-01');
  assert.ok(!byVar('s1e').out.some((e) => e.target === name.id));
  assert.equal(doc.isSaving, false);
});
