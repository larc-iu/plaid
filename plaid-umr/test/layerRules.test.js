// The rule core holds on UMR relations (a relation stays inside its sentence,
// umrConstraints.js) is declared by setup and adopt only: an open asks
// nothing of it, whoever opens and whatever the layer holds (a one-off
// script declared it on the projects made before). An edit core refuses
// under it (422) puts the screen back and says what the server said, as any
// refusal does. The resend rechecks no longer ask for one sentence: core
// refuses that itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseUmrFile } from '../src/domain/format/umrFile.js';
import { planImport } from '../src/domain/umrImport.js';
import { UmrDocument } from '../src/domain/UmrDocument.js';
import { relationRules } from '../src/domain/umrConstraints.js';
import { humanizeError } from '../../plaid-ui/src/lib/errors.js';
import { rawFromPlan } from './rawFromPlan.js';
import { recordingClient } from './recordingClient.js';

const SEP = '#'.repeat(80);
const TEXT = `${SEP}
# :: snt1
Index: 1 2 3
Words: Ali geldi .

# sentence level graph:
(s1g / gel-01
    :ARG1 (s1a / person)
    :time (s1n / now))

# alignment:
s1g: 2-2
s1a: 1-1
s1n: 0-0

# document level annotation:
(s1s0 / sentence)

${SEP}
# :: snt2
Index: 1 2 3
Words: Veli gitti .

# sentence level graph:
(s2g / git-01
    :ARG1 (s2v / person))

# alignment:
s2g: 2-2
s2v: 1-1

# document level annotation:
(s2s0 / sentence)
`;

const MAINTAINER = { id: 'm@x' };
const WRITER = { id: 'w@x' };
const PROJECT = { id: 'p', maintainers: [MAINTAINER.id], writers: [WRITER.id] };

const relationLayerOf = (raw) =>
  raw.textLayers[0].tokenLayers
    .find((l) => l.config?.umr?.nodes)
    .spanLayers[0].relationLayers.find((l) => l.config?.umr?.relations);

const sentenceLayerOf = (raw) =>
  raw.textLayers[0].tokenLayers.find((l) => l.config?.plaid?.role === 'sentence');

const refusal = (count) =>
  Object.assign(new Error('HTTP 422 A relation of layer "UMR relations" crosses sentences.'), {
    status: 422,
    responseData: {
      error: 'A relation of layer "UMR relations" joins two places in different sentences.',
      violations: [{ constraint: 'same-ancestor', namespace: 'umr', ids: ['r1'] }],
      'violation-count': count,
    },
  });

// The recording client with the relation layers' constraint methods, in a
// batch as well as on their own. A check finds stored relations the rule
// would change.
function load({ user = MAINTAINER, stored } = {}) {
  const raw = rawFromPlan(planImport(parseUmrFile(TEXT).sentences, []));
  const layer = relationLayerOf(raw);
  layer.name = 'UMR relations';
  if (stored) layer.constraints = { umr: stored };
  const { client, calls } = recordingClient();
  client.relationLayers = {
    setConstraints: async (...args) => {
      calls.push({ name: 'relationLayers.setConstraints', args });
      return { constraints: { umr: args[2] } };
    },
    checkConstraints: async (...args) => {
      calls.push({ name: 'relationLayers.checkConstraints', args });
      return { violations: [{ constraint: 'same-ancestor' }], violationCount: 1 };
    },
    repairConstraints: async (...args) => {
      calls.push({ name: 'relationLayers.repairConstraints', args });
      return { repaired: [], violations: [], violationCount: 0 };
    },
    get: async () => layer,
  };
  const batched = client.batched;
  client.batched = async (fn) => {
    let layerOps = null;
    const out = await batched(async (b) => {
      const queue = [];
      b.relationLayers = new Proxy(
        {},
        {
          get:
            (_, method) =>
            (...args) =>
              queue.push([method, args]),
        },
      );
      await fn(b);
      layerOps = queue;
    });
    if (!layerOps.length) return out;
    // As the server answers a batch: one result per op, its body inside.
    const results = [];
    for (const [method, args] of layerOps) {
      results.push({ body: await client.relationLayers[method](...args) });
    }
    return results;
  };
  const doc = new UmrDocument({ raw, client, project: PROJECT, user });
  let reloads = 0;
  doc._reload = async () => {
    reloads += 1;
  };
  return { doc, calls, raw, reloads: () => reloads };
}

const ruleFor = (raw) => relationRules(sentenceLayerOf(raw).id);
const constraintCalls = (calls) => calls.filter((c) => c.name.startsWith('relationLayers.'));

test('an open asks nothing of the layer rules, whoever opens and whatever the layer holds', async () => {
  const probe = load();
  const acyclic = [
    ...ruleFor(probe.raw),
    { type: 'acyclic', exceptValues: [':quote', ':modal-predicate'] },
  ];
  for (const options of [
    {},
    { stored: acyclic },
    { stored: ruleFor(probe.raw) },
    { user: WRITER },
    { user: WRITER, stored: acyclic },
  ]) {
    const { doc, calls, reloads } = load(options);
    const result = await doc._reconcile();
    assert.deepEqual(result, { findings: [] });
    assert.deepEqual(constraintCalls(calls), []);
    assert.equal(reloads(), 0);
    assert.equal(doc.describeReconcile(result), null);
  }
});

// ----- the resend rechecks -----

// The recheck an edit is queued with, captured without sending it.
const recheckOf = async (doc, edit) => {
  let recheck = null;
  doc._queueWrite = (label, send, named, options = {}) => {
    recheck = options.recheck;
    return Promise.resolve(true);
  };
  await edit();
  return recheck;
};

// The document read after a refusal, with one node now standing in the
// other sentence.
const movedTo = (doc, nodeId, sentence) => ({
  node: (id) => {
    const n = doc.node(id);
    return n && n.id === nodeId ? { ...n, sentence } : n;
  },
  edge: (id) => doc.edge(id),
  hasEdge: (...args) => doc.hasEdge(...args),
  wouldCycle: (...args) => doc.wouldCycle(...args),
});

const nodeByVar = (doc, v) => [...doc.graph.nodesById.values()].find((n) => n.var === v);

test('an edge sent again no longer asks that its ends share a sentence', async () => {
  const { doc } = load({ user: WRITER });
  const a = nodeByVar(doc, 's1a');
  const n = nodeByVar(doc, 's1n');
  // The read after a refusal, taken before the edge patched the screen.
  const fresh = doc._snapshot(structuredClone(doc.raw), null);
  const recheck = await recheckOf(doc, () => doc.createEdge(a.id, n.id, ':mod'));
  assert.equal(recheck(movedTo(fresh, n.id, 2)), true, 'core refuses a cross-sentence edge');
  const gone = { ...movedTo(fresh, n.id, 1), node: (id) => (id === n.id ? null : fresh.node(id)) };
  assert.equal(recheck(gone), false, 'an end that is gone still refuses the resend');
});

test('a moved edge sent again no longer asks that its ends share a sentence', async () => {
  const { doc } = load({ user: WRITER });
  const a = nodeByVar(doc, 's1a');
  const g = nodeByVar(doc, 's1g');
  const n = nodeByVar(doc, 's1n');
  const edge = g.out.find((e) => e.target === a.id);
  // The read after a refusal, taken before the move patched the screen.
  const fresh = doc._snapshot(structuredClone(doc.raw), null);
  const recheck = await recheckOf(doc, () => doc.moveEdge(edge.id, n.id));
  assert.equal(recheck(movedTo(fresh, a.id, 2)), true, 'core refuses a cross-sentence edge');
  const gone = { ...movedTo(fresh, a.id, 1), node: (id) => (id === n.id ? null : fresh.node(id)) };
  assert.equal(recheck(gone), false, 'a new source that is gone still refuses the resend');
});

test('the one-sentence refusal before sending stays', async () => {
  const { doc, calls } = load({ user: WRITER });
  const a = nodeByVar(doc, 's1a');
  const v = nodeByVar(doc, 's2v');
  assert.equal(await doc.createEdge(a.id, v.id, ':mod'), false);
  assert.deepEqual(
    calls.filter((c) => c.name === 'relations.create'),
    [],
  );
  assert.equal(doc.error, 'An edge joins two nodes of one sentence.');
});

test('an edit refused by the rule (422) is taken off the screen and says why', async () => {
  const { doc, calls } = load({ user: WRITER });
  const a = nodeByVar(doc, 's1a');
  const n = nodeByVar(doc, 's1n');
  const err = refusal(1);
  doc._client.relations.create = async (...args) => {
    calls.push({ name: 'relations.create (refused)', args });
    throw err;
  };
  // The read after the refusal: the document as stored.
  const stored = structuredClone(doc.raw);
  doc._client.documents.get = async () => structuredClone(stored);
  const errors = [];
  doc.onError = (msg, e) => errors.push(e);
  const before = doc.sentence(1).edges.length;
  const result = await doc.createEdge(a.id, n.id, ':mod');
  while (doc.isSaving) await new Promise((r) => setTimeout(r, 0));
  assert.equal(result, false);
  assert.deepEqual(errors, [err]);
  assert.equal(
    humanizeError(err),
    'A relation of layer "UMR relations" joins two places in different sentences.',
  );
  assert.equal(doc.sentence(1).edges.length, before, 'the edge is gone from the screen');
});
