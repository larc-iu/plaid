// Provenance on the canvas: every edit a person makes through UmrDocument
// carries the writer's stamp, and a drafted node nobody has touched keeps
// the machine's. The convention is the cross-app one (plaid-client's
// writerPolicy); this holds UMR's half of it.
//
// Driven through the recording client, so each test reads exactly what the
// mutation sent as well as what the document then says.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROV, provState, PROV_STATES, applyMetadataOps } from '@larc-iu/plaid-client';
import { parseUmrFile } from '../src/domain/format/umrFile.js';
import { planImport } from '../src/domain/umrImport.js';
import { UmrDocument } from '../src/domain/UmrDocument.js';
import { rawFromPlan } from './rawFromPlan.js';
import { recordingClient } from './recordingClient.js';

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'umr',
  'english_umr-0001.umr',
);

// What the draft service writes: flat prov keys beside the `umr` namespace.
const DRAFTED = { [PROV.key]: PROV.INFERRED, [PROV.sourceKey]: 'service:umr-draft-llm' };

const CONTRIBUTOR = 'annotator@example.com';
const REVIEWED_PROJECT = { id: 'p', config: { plaid: { review: { users: [CONTRIBUTOR] } } } };

// The corpus with every node and edge marked machine-drafted, so any write
// that fails to stamp leaves something the review sweep still owns.
function drafted(raw) {
  const text = raw.textLayers[0];
  const nodes = text.tokenLayers.find((l) => l.config?.umr?.nodes);
  const concepts = nodes.spanLayers[0];
  concepts.spans.forEach((s) => {
    s.metadata = { ...DRAFTED, ...s.metadata };
  });
  concepts.relationLayers.forEach((layer) =>
    (layer.relations || []).forEach((r) => {
      r.metadata = { ...DRAFTED, ...r.metadata };
    }),
  );
  return raw;
}

// `edit`, when given, changes the raw document before it loads.
const load = ({ machine = false, user = null, project = null, edit = null } = {}) => {
  const plan = planImport(parseUmrFile(fs.readFileSync(FIXTURE, 'utf8')).sentences, []);
  const raw = rawFromPlan(plan);
  if (machine) drafted(raw);
  if (edit) edit(raw);
  const { client, calls } = recordingClient();
  const doc = new UmrDocument({
    raw,
    client,
    project,
    user,
  });
  doc._reload = async () => {};
  doc.onError = (msg) => {
    throw new Error(msg);
  };
  return { doc, calls };
};

const byVar = (doc, v) => [...doc.graph.nodesById.values()].find((n) => n.var === v);
// A patch's ops as the object they write, a key a top-level op deletes
// reading as null.
const patchObject = (ops) =>
  ops.reduce(
    (m, o) =>
      o.op === 'delete' && o.path.length === 1
        ? { ...m, [o.path[0]]: null }
        : applyMetadataOps(m, [o]),
    {},
  );
// Every metadata object a call carried, whether a create's or a patch's.
const written = (calls) =>
  calls.flatMap((c) => {
    if (c.name === 'spans.create') return [c.args[3] || {}];
    if (c.name === 'relations.create') return [c.args[4] || {}];
    if (c.name.endsWith('patchMetadata')) return [patchObject(c.args[1])];
    return [];
  });
const confirms = (calls) => written(calls).filter((m) => m[PROV.confirmedKey] === true);

test('a verifier has no contributor id and stamps nothing on a create', async () => {
  const { doc, calls } = load({ user: { id: 'maintainer@example.com' }, project: { id: 'p' } });
  assert.equal(doc.contributorId, null);
  const s1 = doc.sentence(1);
  const ok = await doc.createNode({
    sentenceIndex: 1,
    concept: 'thing',
    wordIds: [s1.words[0].id],
  });
  assert.ok(ok.nodeId);
  const create = calls.find((c) => c.name === 'spans.create');
  assert.deepEqual(Object.keys(create.args[3]), ['umr']);
  assert.equal(provState(doc.node(ok.nodeId).metadata), PROV_STATES.HUMAN);
});

test("a contributor's new node and its edge are contributed", async () => {
  const { doc, calls } = load({ user: { id: CONTRIBUTOR }, project: REVIEWED_PROJECT });
  assert.equal(doc.contributorId, CONTRIBUTOR);
  const s1 = doc.sentence(1);
  const ok = await doc.createNode({
    sentenceIndex: 1,
    concept: 'thing',
    wordIds: [s1.words[0].id],
    parentId: s1.roots[0].id,
    role: ':ARG1',
  });
  const span = calls.find((c) => c.name === 'spans.create').args[3];
  const rel = calls.find((c) => c.name === 'relations.create').args[4];
  for (const meta of [span, rel]) {
    assert.equal(meta[PROV.key], PROV.CONTRIBUTED);
    assert.equal(meta[PROV.sourceKey], `user:${CONTRIBUTOR}`);
  }
  assert.equal(provState(doc.node(ok.nodeId).metadata), PROV_STATES.CONTRIBUTED);
});

// The point of the whole convention in this app: the Draft button writes a
// whole sentence, and a node a person then corrects must stop reading as
// machine output.
test("a person's edit of a drafted node confirms it, on the wire and in the graph", async () => {
  const cases = {
    setConcept: (doc, n) => doc.setConcept(n.id, 'nation'),
    setVariable: (doc, n) => doc.setVariable(n.id, `s${n.sentence}zz`),
    setAttrs: (doc, n) => doc.setAttrs(n.id, [{ rel: ':aspect', value: 'state' }]),
    setAnchor: (doc, n) => doc.setAnchor(n.id, [doc.sentence(n.sentence).words[3].id]),
    setRoot: (doc, n) => doc.setRoot(n.id),
  };
  for (const [name, run] of Object.entries(cases)) {
    const { doc, calls } = load({ machine: true });
    const node = byVar(doc, 's1c');
    assert.equal(provState(node.metadata), PROV_STATES.MACHINE, `${name}: drafted to begin with`);
    assert.equal(await run(doc, node), true, name);
    assert.ok(confirms(calls).length >= 1, `${name} sent a confirmation`);
    assert.equal(provState(doc.node(node.id).metadata), PROV_STATES.VERIFIED, name);
    // The drafted node's origin is kept: verified says who it came from.
    assert.equal(doc.node(node.id).metadata[PROV.sourceKey], 'service:umr-draft-llm');
  }
});

test("a person's edit of a drafted edge confirms it", async () => {
  const cases = {
    setRole: (doc, e) => doc.setRole(e.id, ':manner'),
    shiftEdge: (doc, e) => doc.shiftEdge(e.id, -1),
  };
  for (const [name, run] of Object.entries(cases)) {
    const { doc, calls } = load({ machine: true });
    const source = byVar(doc, 's1l');
    const edge = [...source.out].sort((a, b) => a.order - b.order)[1];
    assert.equal(provState(edge.metadata), PROV_STATES.MACHINE, name);
    assert.equal(await run(doc, edge), true, name);
    assert.ok(confirms(calls).length >= 1, `${name} sent a confirmation`);
    assert.equal(provState(doc.edge(edge.id).metadata), PROV_STATES.VERIFIED, name);
  }
});

test('a re-parented edge and a new edge are the writer’s own work', async () => {
  const { doc, calls } = load({
    machine: true,
    user: { id: CONTRIBUTOR },
    project: REVIEWED_PROJECT,
  });
  const s1 = doc.sentence(1);
  const a = byVar(doc, 's1l');
  const b = byVar(doc, 's1c');
  const edgeId = await doc.createEdge(a.id, b.id, ':manner');
  assert.ok(edgeId);
  const made = calls.filter((c) => c.name === 'relations.create').at(-1).args[4];
  assert.equal(made[PROV.key], PROV.CONTRIBUTED);
  const other = s1.nodes.find((n) => n.id !== a.id && n.id !== b.id && n.sentence === 1);
  assert.equal(await doc.moveEdge(edgeId, other.id), true);
  const moved = calls.filter((c) => c.name === 'relations.create').at(-1).args[4];
  assert.equal(moved[PROV.key], PROV.CONTRIBUTED);
});

test("a document-level relation, its constant and its relabel carry the writer's mark", async () => {
  const { doc, calls } = load({
    machine: true,
    user: { id: CONTRIBUTOR },
    project: REVIEWED_PROJECT,
  });
  const node = byVar(doc, 's1l');
  const id = await doc.createTriple({ source: 'past-reference', target: node.id, rel: ':before' });
  assert.ok(id);
  // The constant's span is made on the writer's behalf, so it is theirs too.
  const constant = calls.find((c) => c.name === 'spans.create').args[3];
  assert.equal(constant[PROV.key], PROV.CONTRIBUTED);
  const triple = calls.find((c) => c.name === 'relations.create').args[4];
  assert.equal(triple[PROV.key], PROV.CONTRIBUTED);
  // And relabelling it later marks it again rather than leaving a stale
  // confirmation behind.
  calls.length = 0;
  assert.equal(await doc.setTripleRelation(id, ':after'), true);
  const patch = written(calls).at(-1);
  assert.equal(patch[PROV.key], PROV.CONTRIBUTED);
  assert.equal(patch[PROV.confirmedKey], null);
});

test('text mode stamps what it makes and confirms what it changes', async () => {
  const { doc, calls } = load({ machine: true });
  const text = `(s1l / leave-02
    :ARG0 (s1c / country)
    :purpose (s1q / quit-01))`;
  assert.ok(await doc.applyPenman(1, text));
  // The nodes it made are the writer's (a verifier leaves no keys), and
  // every node it changed is confirmed rather than left as the draft's.
  assert.ok(confirms(calls).length >= 1, 'text mode confirmed what it edited');
  const created = calls.filter((c) => c.name === 'spans.bulkCreate').flatMap((c) => c.args[0]);
  assert.ok(created.length >= 1);
  created.forEach((op) => assert.deepEqual(Object.keys(op.metadata), ['umr']));
});

// Taking a child out moves the places of the children after it. That is a
// renumber, not anyone's edit of them, so they keep the machine's stamp.
test('text mode leaves a child it only renumbers as the machine left it', async () => {
  const { doc, calls } = load({ machine: true });
  const text = doc
    .penmanOf(1)
    .replace(/\n +:wiki "Philippines"/, '')
    .replace(/\n +:ARG1 \(s1p3 \/ person\n +:quant 200\)/, '');
  const name = doc.node(byVar(doc, 's1c').id).out.find((e) => e.role === ':name');
  const plan = doc.planPenman(1, text);
  assert.deepEqual(plan.orders, [{ edgeId: name.id, order: 0, moved: false }]);
  assert.ok(await doc.applyPenman(1, text));
  // The edge and the node whose places moved are untouched.
  assert.equal(provState(doc.edge(name.id).metadata), PROV_STATES.MACHINE);
  assert.equal(provState(doc.node(byVar(doc, 's1d').id).metadata), PROV_STATES.MACHINE);
  // The node that lost an attribute was edited, and is confirmed.
  assert.equal(provState(doc.node(byVar(doc, 's1c').id).metadata), PROV_STATES.VERIFIED);
  const orderPatch = calls.find(
    (c) => c.name === 'relations.patchMetadata' && c.args[0] === name.id,
  );
  assert.equal(patchObject(orderPatch.args[1])[PROV.confirmedKey], undefined);
});

// Swapping two children in the text is a move, the person's as the same move
// on the canvas is: both edges it moved are confirmed, and nothing else.
test('text mode confirms the edges a person put in another order', async () => {
  const { doc } = load({ machine: true });
  const landslide = byVar(doc, 's1l');
  const place = landslide.out.find((e) => e.role === ':place');
  const arg3 = landslide.out.find((e) => e.role === ':ARG3');
  const op1 = byVar(doc, 's1a').out.find((e) => e.role === ':op1');
  const text = `(s1p / override-91
    :ARG1 (s1l / landslide-01
        :place (s1c / country
            :wiki "Philippines"
            :name (s1n / name
                :op1 "Philippines"))
        :ARG3 (s1a / and
            :op1 (s1d / die-01
                :ARG1 (s1p3 / person
                    :quant 200)
                :aspect state)
            :op2 (s1f / fear-01
                :ARG1 (s1m / miss-01
                    :ARG1 (s1p2 / person
                        :quant 1500)
                    :aspect state)
                :aspect state)
            :aspect process)))`;
  assert.ok(await doc.applyPenman(1, text));
  assert.equal(provState(doc.edge(place.id).metadata), PROV_STATES.VERIFIED);
  assert.equal(provState(doc.edge(arg3.id).metadata), PROV_STATES.VERIFIED);
  assert.equal(provState(doc.edge(op1.id).metadata), PROV_STATES.MACHINE);
  assert.equal(provState(doc.node(landslide.id).metadata), PROV_STATES.MACHINE);
});

test('a service write nobody has touched stays machine-made', async () => {
  const { doc } = load({ machine: true });
  const edited = byVar(doc, 's1c');
  const untouched = byVar(doc, 's1p');
  assert.equal(await doc.setConcept(edited.id, 'nation'), true);
  assert.equal(provState(doc.node(edited.id).metadata), PROV_STATES.VERIFIED);
  // Its neighbour is exactly as the service left it.
  assert.equal(provState(doc.node(untouched.id).metadata), PROV_STATES.MACHINE);
  assert.equal(doc.node(untouched.id).metadata[PROV.confirmedKey], undefined);
});

// A repair that runs on open decides nothing, so it vouches for nothing.
test('reconcile leaves provenance alone', async () => {
  const { doc, calls } = load({ machine: true });
  const node = byVar(doc, 's1a');
  assert.ok(node && !node.aligned, 'the corpus has an unaligned node');
  await doc._reconcile();
  assert.equal(confirms(calls).length, 0);
});

// The review gesture: a person looked at a drafted node and vouches for it.
test('confirming a node confirms it and its relation to its parent, and nothing else', async () => {
  const { doc, calls } = load({ machine: true });
  const country = byVar(doc, 's1c');
  const into = country.in[0];
  const name = byVar(doc, 's1n');
  assert.equal(doc.canConfirm(country.id), true);
  assert.equal(await doc.confirmNode(country.id), true);
  assert.equal(provState(doc.node(country.id).metadata), PROV_STATES.VERIFIED);
  assert.equal(provState(doc.edge(into.id).metadata), PROV_STATES.VERIFIED);
  // Its child and the edge down to it are the child's, not this node's.
  assert.equal(provState(doc.node(name.id).metadata), PROV_STATES.MACHINE);
  const down = doc.node(country.id).out[0];
  assert.equal(provState(doc.edge(down.id).metadata), PROV_STATES.MACHINE);
  // The draft's origin is kept, as for any edit.
  assert.equal(doc.node(country.id).metadata[PROV.sourceKey], 'service:umr-draft-llm');
  const patched = calls.filter((c) => c.name.endsWith('patchMetadata')).map((c) => c.args[0]);
  assert.deepEqual(new Set(patched), new Set([country.id, into.id]));
  // The history names the gesture as the canvas does: Accept.
  assert.ok(
    calls.some((c) => c.name === 'operation' && c.args[0] === `Accept ${country.var}`),
    'the operation is named Accept',
  );
  // Nothing is left to confirm, so a second confirm writes nothing.
  assert.equal(doc.canConfirm(country.id), false);
  const before = calls.length;
  assert.equal(await doc.confirmNode(country.id), false);
  assert.equal(calls.length, before);
});

test("confirming a sentence's graph confirms every node and edge in it", async () => {
  const { doc, calls } = load({ machine: true });
  assert.equal(doc.canConfirmSentence(1), true);
  assert.equal(await doc.confirmSentence(1), true);
  assert.ok(
    calls.some((c) => c.name === 'operation' && c.args[0] === 'Accept the graph of sentence 1'),
    'the operation is named as the Accept graph button is',
  );
  const s1 = doc.sentence(1);
  s1.nodes.forEach((n) => assert.equal(provState(n.metadata), PROV_STATES.VERIFIED, n.var));
  s1.edges.forEach((e) => assert.equal(provState(e.metadata), PROV_STATES.VERIFIED, e.role));
  assert.equal(doc.canConfirmSentence(1), false);
  // The next sentence is still the machine's.
  assert.equal(provState(doc.sentence(2).nodes[0].metadata), PROV_STATES.MACHINE);
});

test("a contributor's confirm is a contribution, never a verification", async () => {
  const { doc } = load({ machine: true, user: { id: CONTRIBUTOR }, project: REVIEWED_PROJECT });
  const country = byVar(doc, 's1c');
  assert.equal(await doc.confirmNode(country.id), true);
  assert.equal(provState(doc.node(country.id).metadata), PROV_STATES.CONTRIBUTED);
});

// Discard graph: the sentence's drafted material goes, and what a person
// made or accepted stays.
const rawLayers = (raw) => {
  const nodes = raw.textLayers[0].tokenLayers.find((l) => l.config?.umr?.nodes);
  const concepts = nodes.spanLayers[0];
  return {
    spans: concepts.spans,
    relations: concepts.relationLayers.flatMap((l) => l.relations || []),
  };
};
const rawByVar = (raw, v) => rawLayers(raw).spans.find((s) => s.metadata?.umr?.var === v);
const nodesOf = (doc, i) =>
  doc
    .sentence(i)
    .nodes.map((n) => n.var)
    .sort();
const operations = (calls) => calls.filter((c) => c.name === 'operation').map((c) => c.args[0]);

test("discarding a sentence's draft removes its drafted nodes and relations and nothing else", async () => {
  const { doc, calls } = load({ machine: true });
  const s2 = nodesOf(doc, 2);
  const s1Triples = doc.sentence(1).triples.length;
  assert.ok(s1Triples > 0, 'the fixture has triples in the first block');
  assert.equal(doc.canDiscardSentence(1), true);
  const plan = doc.discardPlan(1);
  assert.equal(plan.nodes.length, doc.sentence(1).nodes.length);
  assert.equal(await doc.discardSentence(1), true);
  assert.deepEqual(operations(calls), ['Discard the drafted graph of sentence 1']);
  assert.deepEqual(nodesOf(doc, 1), []);
  assert.equal(doc.sentence(1).edges.length, 0);
  // All but `root :modal author`, which every sentence's block writes, so
  // it is not this sentence's alone to discard.
  const left = doc.sentence(1).triples;
  assert.deepEqual(
    left.map((t) => [doc.node(t.source).var, t.rel, doc.node(t.target).var]),
    [['root', ':modal', 'author']],
  );
  assert.ok(doc.sentence(2).triples.includes(left[0]));
  // The next sentence keeps every node, and loses only the drafted
  // coreference onto the first sentence's nodes.
  assert.deepEqual(nodesOf(doc, 2), s2);
  assert.ok(
    doc.sentence(2).triples.every((t) => doc.node(t.source) && doc.node(t.target)),
    'no triple is left hanging',
  );
  // The anchors go in one bulk delete, whose cascade takes the spans and
  // every relation on them.
  const deleted = calls.find((c) => c.name === 'tokens.bulkDelete').args[0];
  assert.equal(deleted.length, plan.nodes.flatMap((n) => n.pieces).length);
  // Nothing is left to discard.
  assert.equal(doc.canDiscardSentence(1), false);
  const before = calls.length;
  assert.equal(await doc.discardSentence(1), false);
  assert.equal(calls.length, before);
});

test('discarding keeps an accepted node, and the node its accepted relation needs', async () => {
  const { doc } = load({ machine: true });
  const country = byVar(doc, 's1c');
  // Accepts s1c and its :place edge from the root s1p.
  assert.equal(await doc.confirmNode(country.id), true);
  assert.equal(await doc.discardSentence(1), true);
  // s1l stays, still drafted, since the accepted :place hangs from it.
  assert.deepEqual(nodesOf(doc, 1), ['s1c', 's1l']);
  assert.deepEqual(
    doc.sentence(1).edges.map((e) => e.role),
    [':place'],
  );
  assert.equal(provState(byVar(doc, 's1l').metadata), PROV_STATES.MACHINE);
  // What stays drafted is kept for Accept graph, and Discard has nothing left.
  assert.equal(doc.canConfirmSentence(1), true);
  assert.equal(doc.canDiscardSentence(1), false);
});

test("discarding keeps a person's node, a contributor's node, and a node a person's triple needs", async () => {
  const { doc, calls } = load({
    machine: true,
    edit: (raw) => {
      // s1d a person's own, s1f a contributor's.
      const human = rawByVar(raw, 's1d');
      delete human.metadata[PROV.key];
      delete human.metadata[PROV.sourceKey];
      Object.assign(rawByVar(raw, 's1f').metadata, {
        [PROV.key]: PROV.CONTRIBUTED,
        [PROV.sourceKey]: `user:${CONTRIBUTOR}`,
      });
      // A person wrote sentence 3's coreference onto s1m, accepted.
      const m = rawByVar(raw, 's1m');
      const triple = rawLayers(raw).relations.find(
        (r) => r.value === ':same-event' && (r.source === m.id || r.target === m.id),
      );
      assert.ok(triple, 'the fixture corefers s1m with sentence 3');
      triple.metadata[PROV.confirmedKey] = true;
    },
  });
  assert.equal(await doc.discardSentence(1), true);
  assert.deepEqual(nodesOf(doc, 1), ['s1d', 's1f', 's1m']);
  // The drafted edges among what stays go too, so the kept nodes stand alone.
  assert.equal(doc.sentence(1).edges.length, 0);
  assert.ok(calls.some((c) => c.name === 'relations.delete'));
  const m = byVar(doc, 's1m');
  assert.deepEqual(
    [...m.docIn, ...m.docOut].map((t) => t.rel),
    [':same-event'],
  );
});

test('discarding writes nothing at a past state', async () => {
  const { doc } = load({ machine: true });
  const past = doc._snapshot(doc._raw, '2026-01-01T00:00:00Z');
  const errors = [];
  past.onError = (msg) => errors.push(msg);
  const nodes = past.sentence(1).nodes.length;
  assert.equal(await past.discardSentence(1), false);
  assert.equal(past.sentence(1).nodes.length, nodes);
  assert.equal(errors.length, 1);
});
