// The rule core holds on UMR relations (a relation stays inside its sentence,
// umrConstraints.js): a maintainer's open declares it when the layer lacks
// it, after core's repair, and reports data that keeps it out as ONE finding.
// Nobody else declares. And an edit core refuses under it (422) puts the
// screen back and says what the server said, as any refusal does. The resend
// rechecks no longer ask for one sentence: core refuses that itself.
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
// batch as well as on their own. `declare` answers setConstraints: an error
// to throw, or nothing for a landed declaration. `broken` is whether a check
// finds stored relations the rule would change.
function load({ user = MAINTAINER, stored, declare = null, broken = true } = {}) {
  const raw = rawFromPlan(planImport(parseUmrFile(TEXT).sentences, []));
  const layer = relationLayerOf(raw);
  layer.name = 'UMR relations';
  if (stored) layer.constraints = { umr: stored };
  const { client, calls } = recordingClient();
  client.relationLayers = {
    setConstraints: async (...args) => {
      calls.push({ name: 'relationLayers.setConstraints', args });
      if (declare) throw declare;
      return { constraints: { umr: args[2] } };
    },
    checkConstraints: async (...args) => {
      calls.push({ name: 'relationLayers.checkConstraints', args });
      return broken
        ? { violations: [{ constraint: 'same-ancestor' }], violationCount: 1 }
        : { violations: [], violationCount: 0 };
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

test('an open by a maintainer on a layer that already holds the rule writes nothing', async () => {
  const probe = load();
  const { doc, calls } = load({ stored: ruleFor(probe.raw) });
  const result = await doc._reconcile();
  assert.deepEqual(result, { findings: [] });
  assert.deepEqual(constraintCalls(calls), []);
  assert.equal(doc.describeReconcile(result), null);
});

test('an open by a maintainer repairs, then declares the rule on UMR relations only', async () => {
  const { doc, calls, raw, reloads } = load();
  const result = await doc._reconcile();
  const layerId = relationLayerOf(raw).id;
  const made = constraintCalls(calls);
  assert.deepEqual(
    made.map((c) => c.name),
    [
      'relationLayers.checkConstraints',
      'relationLayers.repairConstraints',
      'relationLayers.setConstraints',
    ],
  );
  const remediable = ruleFor(raw).filter((r) => r.type === 'same-ancestor');
  assert.deepEqual(
    made[0].args,
    [layerId, remediable],
    'the rules with a remedy are checked first',
  );
  assert.deepEqual(made[1].args, [layerId, remediable]);
  assert.deepEqual(made[2].args, [layerId, 'umr', ruleFor(raw), undefined, { expected: null }]);
  assert.deepEqual(result, { findings: [], rulesDeclared: true });
  assert.equal(reloads(), 1, 'read again after core repaired the project');
  assert.match(
    doc.describeReconcile(result),
    /set up the rule that a relation stays inside its sentence$/,
  );
  assert.ok(
    calls.some((c) => c.name === 'operation' && c.args[0] === 'Set up layer rules'),
    'the declaration is one labelled operation',
  );
});

// REV-FX-CORE F5: UMR no longer asks core for `acyclic` (the canvas and the
// services hold the cycle rule). A layer an earlier open declared it on has
// it taken off by a maintainer's open, once.
test('the rule is same-ancestor alone, and a declared acyclic is taken off once', async () => {
  const probe = load();
  assert.deepEqual(
    ruleFor(probe.raw).map((r) => r.type),
    ['same-ancestor'],
  );
  const old = [
    ...ruleFor(probe.raw),
    { type: 'acyclic', exceptValues: [':quote', ':modal-predicate'] },
  ];
  const { doc, calls, raw } = load({ stored: old, broken: false });
  const result = await doc._reconcile();
  const set = constraintCalls(calls).filter((c) => c.name === 'relationLayers.setConstraints');
  assert.equal(set.length, 1);
  assert.deepEqual(set[0].args, [
    relationLayerOf(raw).id,
    'umr',
    ruleFor(raw),
    undefined,
    { expected: old },
  ]);
  assert.deepEqual(result.findings, []);
  const again = load({ stored: ruleFor(raw) });
  assert.deepEqual(await again.doc._reconcile(), { findings: [] });
  assert.deepEqual(constraintCalls(again.calls), []);
});

// H9-FIRST-OPEN-3: a repair holds the write lock over the whole layer.
test('an open by a maintainer declares the rule on clean data with no repair', async () => {
  const { doc, calls } = load({ broken: false });
  const result = await doc._reconcile();
  assert.deepEqual(
    constraintCalls(calls).map((c) => c.name),
    ['relationLayers.checkConstraints', 'relationLayers.setConstraints'],
  );
  assert.deepEqual(result, { findings: [], rulesDeclared: true });
});

test('an open by a writer who is not a maintainer repairs the document opened and declares nothing', async () => {
  const { doc, calls, raw, reloads } = load({ user: WRITER });
  const result = await doc._reconcile();
  assert.deepEqual(result, { findings: [] });
  assert.deepEqual(constraintCalls(calls), [
    {
      name: 'relationLayers.repairConstraints',
      args: [relationLayerOf(raw).id, ruleFor(raw), undefined, { document: doc.id }],
    },
  ]);
  assert.equal(reloads(), 0, 'nothing was repaired, so nothing is read again');
});

test('an open by a writer once the rule is declared asks for nothing', async () => {
  const probe = load();
  const { doc, calls } = load({ user: WRITER, stored: ruleFor(probe.raw) });
  assert.deepEqual(await doc._reconcile(), { findings: [] });
  assert.deepEqual(constraintCalls(calls), []);
});

test('a declaration the stored data refuses becomes one warning', async () => {
  const { doc } = load({ declare: refusal(2) });
  const result = await doc._reconcile();
  assert.equal(result.findings.length, 1);
  const [finding] = result.findings;
  assert.equal(finding.severity, 'warning');
  assert.equal(finding.code, 'layer-rules-not-in-force');
  assert.equal(
    finding.message,
    'The same-ancestor rules of "UMR relations" are not in force: 2 stored relations break them.',
  );
  assert.equal(result.rulesDeclared, undefined);
});

test('a failed declaration fails the repair, which is tried again on the next open', async () => {
  const lost = Object.assign(new Error('HTTP 500 boom'), { status: 500 });
  const { doc } = load({ declare: lost });
  const result = await doc._reconcile();
  assert.equal(result.error, lost);
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
