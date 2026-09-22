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
import { PROV, provState, PROV_STATES } from '@larc-iu/plaid-client';
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

const load = ({ machine = false, user = null, project = null } = {}) => {
  const plan = planImport(parseUmrFile(fs.readFileSync(FIXTURE, 'utf8')).sentences, []);
  const raw = rawFromPlan(plan);
  const { client, calls } = recordingClient();
  const doc = new UmrDocument({
    raw: machine ? drafted(raw) : raw,
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
// Every metadata object a call carried, whether a create's or a patch's.
const written = (calls) =>
  calls.flatMap((c) => {
    if (c.name === 'spans.create') return [c.args[3] || {}];
    if (c.name === 'relations.create') return [c.args[4] || {}];
    if (c.name.endsWith('patchMetadata')) return [c.args[1] || {}];
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
    setRole: (doc, e) => doc.setRole(e.id, ':location'),
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
  const edgeId = await doc.createEdge(a.id, b.id, ':location');
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
  const created = calls.filter((c) => c.name === 'spans.create');
  assert.ok(created.length >= 1);
  created.forEach((c) => assert.deepEqual(Object.keys(c.args[3]), ['umr']));
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
