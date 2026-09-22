// ConlluDocument's writes to the enhanced relation layer, offline against a
// stub client. What the layer's rows MEAN is enhancedGraph.test.js; this is
// that every write which touches a relation leaves the two layers agreeing.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ConlluDocument } from '../src/domain/ConlluDocument.js';
import { enhancedEdges, isSuppressor } from '../src/domain/enhancedGraph.js';
import { parseGrs } from '../src/grew/parser.js';
import { graphFromSentence } from '../src/grew/rewrite/graph.js';
import { rewriteSentence } from '../src/grew/rewrite/engine.js';
import { diffGraphs } from '../src/grew/rewrite/diff.js';
import { rawDocFromConllu } from './helpers/rawDoc.js';
import { withOps } from './helpers/stubClient.js';

const INPUT = [
  '# text = she came and left home',
  '1\tshe\tshe\tPRON\t_\t_\t2\tnsubj\t_\t_',
  '2\tcame\tcome\tVERB\t_\t_\t0\troot\t_\t_',
  '3\tand\tand\tCCONJ\t_\t_\t4\tcc\t_\t_',
  '4\tleft\tleave\tVERB\t_\t_\t2\tconj\t_\t_',
  '5\thome\thome\tNOUN\t_\t_\t4\tobj\t_\t_',
].join('\n');

// A client that mints relation ids and records every relation write.
const relationClient = () => {
  let n = 0;
  const log = [];
  const client = withOps({
    relations: {
      create: async (layerId, source, target, value, metadata) => {
        const id = `new-${n++}`;
        log.push({ op: 'create', id, layerId, source, target, value, metadata });
        return { id };
      },
      delete: async (id) => {
        log.push({ op: 'delete', id });
      },
    },
  });
  return { client, log };
};

const open = (input = INPUT, options = { enhanced: true }) => {
  const { client, log } = relationClient();
  const doc = new ConlluDocument({ raw: rawDocFromConllu(input, 'e', options), client });
  const lemma = (value) => doc.layerInfo.lemmaLayer.spans.find((s) => s.value === value).id;
  const basic = (value) => doc.layerInfo.relationLayer.relations.find((r) => r.value === value);
  const rows = () => doc.layerInfo.enhancedRelationLayer.relations;
  const graph = () =>
    enhancedEdges(doc.layerInfo.relationLayer.relations, rows())
      .map(
        (e) =>
          `${e.source === e.target ? 'ROOT' : lemmaValue(doc, e.source)}>${lemmaValue(doc, e.target)}:${e.value}`,
      )
      .sort();
  return { doc, log, lemma, basic, rows, graph };
};

const lemmaValue = (doc, spanId) =>
  doc.layerInfo.lemmaLayer.spans.find((s) => s.id === spanId)?.value;

// The document's enhanced graph, as `head>dependent:label` lines.
const graphOf = (doc) =>
  enhancedEdges(
    doc.layerInfo.relationLayer.relations,
    doc.layerInfo.enhancedRelationLayer.relations,
  )
    .map(
      (e) =>
        `${e.source === e.target ? 'ROOT' : lemmaValue(doc, e.source)}>${lemmaValue(doc, e.target)}:${e.value}`,
    )
    .sort();

test('an enhanced edge gives a word a second head and leaves its tree alone', async () => {
  const { doc, log, lemma, rows, graph } = open();
  const id = await doc.createEnhancedRelation(lemma('leave'), lemma('she'), 'nsubj');

  assert.equal(id, 'new-0');
  assert.deepEqual(
    log.map((l) => [l.op, l.layerId, l.value]),
    [['create', 'enhanced-relation-layer', 'nsubj']],
  );
  assert.equal(doc.layerInfo.relationLayer.relations.length, 5);
  assert.equal(rows().length, 1);
  assert.ok(graph().includes('come>she:nsubj'));
  assert.ok(graph().includes('leave>she:nsubj'));
});

test('the same enhanced edge twice is written once', async () => {
  const { doc, log, lemma } = open();
  await doc.createEnhancedRelation(lemma('leave'), lemma('she'), 'nsubj');
  assert.equal(await doc.createEnhancedRelation(lemma('leave'), lemma('she'), 'nsubj'), null);
  assert.equal(log.length, 1);
});

test('an enhanced edge over a basic relation relabels it in the graph', async () => {
  const { doc, log, lemma, rows, graph } = open();
  await doc.createEnhancedRelation(lemma('come'), lemma('leave'), 'conj:and');

  // One batch: the suppressor, then the new label.
  assert.deepEqual(
    log.map((l) => [l.value, l.metadata]),
    [
      [null, { suppress: true }],
      ['conj:and', undefined],
    ],
  );
  assert.equal(rows().filter(isSuppressor).length, 1);
  assert.ok(graph().includes('come>leave:conj:and'));
  assert.ok(!graph().includes('come>leave:conj'));
  // The tree still says `conj`.
  assert.equal(doc.toConllu().includes('\t2\tconj\t2:conj:and\t'), true);
});

test('an unlabelled enhanced edge over a basic relation starts from its label', async () => {
  const { doc, log, lemma } = open();
  await doc.createEnhancedRelation(lemma('come'), lemma('leave'));
  assert.equal(log.at(-1).value, 'conj');
});

test('setRelationSuppressed takes a basic relation out of the graph and puts it back', async () => {
  const { doc, log, basic, rows, graph } = open();
  const obj = basic('obj');

  assert.equal(await doc.setRelationSuppressed(obj.id, true), true);
  assert.equal(rows().length, 1);
  assert.ok(!graph().includes('leave>home:obj'));
  // Already so: nothing is written.
  assert.equal(await doc.setRelationSuppressed(obj.id, true), true);
  assert.equal(log.length, 1);

  assert.equal(await doc.setRelationSuppressed(obj.id, false), true);
  assert.deepEqual(rows(), []);
  assert.ok(graph().includes('leave>home:obj'));
  assert.deepEqual(log.at(-1), { op: 'delete', id: 'new-0' });
});

test('deleting a basic relation takes the suppressor lying over it', async () => {
  const { doc, log, basic, rows } = open();
  const obj = basic('obj');
  await doc.setRelationSuppressed(obj.id, true);

  await doc.deleteRelation(obj.id);
  assert.deepEqual(rows(), []);
  assert.deepEqual(
    log
      .filter((l) => l.op === 'delete')
      .map((l) => l.id)
      .sort(),
    [obj.id, 'new-0'].sort(),
  );
});

test('deleting an enhanced edge touches nothing else', async () => {
  const { doc, log, lemma, rows } = open();
  const id = await doc.createEnhancedRelation(lemma('leave'), lemma('she'), 'nsubj');
  await doc.deleteRelation(id);
  assert.deepEqual(rows(), []);
  assert.equal(doc.layerInfo.relationLayer.relations.length, 5);
  assert.deepEqual(log.at(-1), { op: 'delete', id });
});

test('re-pointing a head clears the suppressor over the relation it replaces', async () => {
  const { doc, lemma, basic, rows } = open();
  await doc.setRelationSuppressed(basic('obj').id, true);

  await doc.createRelation(lemma('come'), lemma('home'), 'obj');
  assert.deepEqual(rows(), []);
});

test('a relation drawn over a pair someone else left a suppressor on is not born faded', async () => {
  // The other direction of the same guard, and the one that covers writers
  // outside this editor: an agent `set_head`, a script or the Python client
  // moves a basic relation and leaves the suppressor over the pair it left
  // behind. Only reconcile-on-OPEN sweeps those, and the assistant panel is
  // app chrome, so a person can have the document open while one runs. The
  // arc they then draw over that pair must not adopt the stale row and come
  // up faded, with no enhanced head and nothing on screen saying why.
  const { client, log } = relationClient();
  const raw = rawDocFromConllu(INPUT, 'e', { enhanced: true });
  const lemmaLayer = raw.textLayers[0].tokenLayers[2].spanLayers[1];
  const spanId = (value) => lemmaLayer.spans.find((s) => s.value === value).id;
  lemmaLayer.relationLayers[1].relations.push({
    id: 'stale',
    source: spanId('come'),
    target: spanId('home'),
    value: null,
    metadata: { suppress: true },
  });
  const doc = new ConlluDocument({ raw, client });

  await doc.createRelation(spanId('come'), spanId('home'), 'obj');

  assert.deepEqual(doc.layerInfo.enhancedRelationLayer.relations, []);
  assert.ok(
    log.some((l) => l.op === 'delete' && l.id === 'stale'),
    'the stale suppressor was not deleted on the server',
  );
  const edges = enhancedEdges(
    doc.layerInfo.relationLayer.relations,
    doc.layerInfo.enhancedRelationLayer.relations,
  );
  assert.ok(
    edges.some(
      (e) => e.source === spanId('come') && e.target === spanId('home') && e.value === 'obj',
    ),
    'the new relation is missing from the enhanced graph',
  );
});

test('deleting the label a relabel gave puts the tree relation back in the graph', async () => {
  // Ruling of 2026-09-21: the bin does what Grew's `del_edge` does. A relabel
  // is one suppressor plus one extra, so deleting the extra alone left the
  // word with no enhanced head at all and `_` in DEPS.
  const { doc, lemma, rows, graph } = open();
  const id = await doc.createEnhancedRelation(lemma('come'), lemma('leave'), 'conj:and');
  assert.equal(rows().length, 2, 'a relabel is a suppressor plus an extra');
  assert.ok(!graph().includes('come>leave:conj'));

  await doc.deleteRelation(id);
  assert.deepEqual(rows(), []);
  assert.ok(graph().includes('come>leave:conj'), "the tree's relation is back in the graph");
});

test('one of two labels over a suppressed pair leaves the suppressor standing', async () => {
  // The rare graph that wants both labels over one pair. Only the LAST extra
  // over the pair undoes the relabel.
  const { doc, lemma, rows, graph } = open();
  const first = await doc.createEnhancedRelation(lemma('come'), lemma('leave'), 'conj:and');
  const second = await doc.createEnhancedRelation(lemma('come'), lemma('leave'), 'conj:but');

  await doc.deleteRelation(first);
  assert.equal(rows().filter(isSuppressor).length, 1);
  assert.ok(!graph().includes('come>leave:conj'));

  await doc.deleteRelation(second);
  assert.deepEqual(rows(), []);
  assert.ok(graph().includes('come>leave:conj'));
});

test('a relation simply left out of the graph stays out when an extra elsewhere goes', async () => {
  const { doc, lemma, basic, rows, graph } = open();
  await doc.setRelationSuppressed(basic('obj').id, true);
  const id = await doc.createEnhancedRelation(lemma('leave'), lemma('she'), 'nsubj');

  await doc.deleteRelation(id);
  assert.equal(rows().filter(isSuppressor).length, 1);
  assert.ok(!graph().includes('leave>home:obj'));
});

test('the bin and a Grew del_edge leave the same enhanced graph', async () => {
  // The same gesture on the same data must end in one state. The editor's
  // path is `deleteRelation`; the rewrite's is `diffGraphs` (`relabelUndone`).
  const RELABELLED = [
    '# text = she came and left home',
    '1\tshe\tshe\tPRON\t_\t_\t2\tnsubj\t2:nsubj\t_',
    '2\tcame\tcome\tVERB\t_\t_\t0\troot\t0:root\t_',
    '3\tand\tand\tCCONJ\t_\t_\t4\tcc\t4:cc\t_',
    '4\tleft\tleave\tVERB\t_\t_\t2\tconj\t2:conj:and\t_',
    '5\thome\thome\tNOUN\t_\t_\t4\tobj\t4:obj\t_',
  ].join('\n');

  const { doc: byHand } = open(RELABELLED);
  const extra = byHand.layerInfo.enhancedRelationLayer.relations.find(
    (r) => r.value === 'conj:and',
  );
  await byHand.deleteRelation(extra.id);

  const byRule = new ConlluDocument({ raw: rawDocFromConllu(RELABELLED, 'e', { enhanced: true }) });
  const before = graphFromSentence(byRule.sentences[0]);
  const { graph: after, applications } = rewriteSentence(
    parseGrs('pattern { V -[E:conj:and]-> W } commands { del_edge V -[E:conj:and]-> W }'),
    before,
  );
  assert.equal(applications.length, 1);
  const { writes } = diffGraphs(before, after, byRule.layerInfo);
  // Both halves of the relabel go, and nothing else: an applier of one op is
  // enough, and this says so if that ever stops being true.
  assert.deepEqual(new Set(writes.main.map((w) => w.op)), new Set(['deleteRelation']));
  assert.deepEqual(writes.lemmaCreates, []);
  const gone = new Set(writes.main.map((w) => w.id));
  const layer = byRule.layerInfo.enhancedRelationLayer;
  layer.relations = layer.relations.filter((r) => !gone.has(r.id));

  assert.deepEqual(graphOf(byHand), graphOf(byRule));
  assert.ok(graphOf(byHand).includes('come>leave:conj'));
});

test('a project with no enhanced layer refuses an enhanced edge', async () => {
  const { doc, log, lemma } = open(INPUT, {});
  assert.equal(await doc.createEnhancedRelation(lemma('leave'), lemma('she'), 'nsubj'), false);
  assert.deepEqual(log, []);
});

test('a sentence split deletes the enhanced edges it cuts as well as the basic ones', async () => {
  const { client } = relationClient();
  const deleted = [];
  client.tokens = { split: async () => ({ id: 'sent-right' }) };
  client.relations.delete = async (id) => deleted.push(id);
  const raw = rawDocFromConllu(INPUT, 'e', { enhanced: true });
  const doc = new ConlluDocument({ raw, client });
  const lemma = (v) => doc.layerInfo.lemmaLayer.spans.find((s) => s.value === v).id;
  const extra = await doc.createEnhancedRelation(lemma('leave'), lemma('she'), 'nsubj');

  // Split before "and": she | came  //  and left home.
  const and = doc.layerInfo.wordTokenLayer.tokens[2];
  await doc.toggleSentenceBoundary(and.begin);

  assert.ok(deleted.includes(extra), 'the enhanced edge leave>she crossed the boundary');
  assert.deepEqual(doc.layerInfo.enhancedRelationLayer.relations, []);
  // The basic conj(come, leave) crossed too, as it always has.
  assert.equal(
    doc.layerInfo.relationLayer.relations.some((r) => r.value === 'conj'),
    false,
  );
});

test('reconcile deletes a suppressor whose basic relation another writer removed', async () => {
  const raw = rawDocFromConllu(INPUT, 'e', { enhanced: true });
  const layer = raw.textLayers[0].tokenLayers[2].spanLayers[1].relationLayers;
  const obj = layer[0].relations.find((r) => r.value === 'obj');
  layer[1].relations.push({
    id: 'stale',
    source: obj.source,
    target: obj.target,
    value: null,
    metadata: { suppress: true },
  });
  layer[1].relations.push({
    id: 'live',
    source: layer[0].relations.find((r) => r.value === 'cc').source,
    target: layer[0].relations.find((r) => r.value === 'cc').target,
    value: null,
    metadata: { suppress: true },
  });
  // Another writer re-parsed: the basic `obj` is gone, its suppressor is not.
  layer[0].relations = layer[0].relations.filter((r) => r.id !== obj.id);

  const deleted = [];
  const after = structuredClone(raw);
  const afterLayers = after.textLayers[0].tokenLayers[2].spanLayers[1].relationLayers;
  afterLayers[1].relations = afterLayers[1].relations.filter((r) => r.id !== 'stale');
  const client = withOps({
    relations: { delete: async (id) => deleted.push(id) },
    documents: { get: async () => after },
    tokenLayers: { setConfig: async () => {} },
  });
  const doc = new ConlluDocument({ raw, client });
  const result = await doc._reconcile();

  assert.deepEqual(deleted, ['stale']);
  // Housekeeping, not a loss: nothing is reported to the annotator.
  assert.equal(result.deletedRelations, 0);
  assert.equal(doc.describeReconcile(result), null);
});

// A project from before the enhanced layer existed is given one the first time
// a maintainer opens a document in it, as it was given `preserveOnSplit`.
const backfillClient = (raw, calls) =>
  withOps({
    relationLayers: {
      create: async (spanLayerId, name) => {
        calls.push(['create', spanLayerId, name]);
        return { id: 'enhanced-new' };
      },
      setConfig: async (...args) => calls.push(['setConfig', ...args]),
    },
    tokenLayers: { setConfig: async () => {} },
    documents: { get: async () => rawDocFromConllu(INPUT, 'e', { enhanced: true }) },
  });

test('reconcile adds the enhanced layer to a project that has none, for a maintainer', async () => {
  const raw = rawDocFromConllu(INPUT, 'e');
  const calls = [];
  const doc = new ConlluDocument({
    raw,
    client: backfillClient(raw, calls),
    project: { maintainers: ['m@x.org'] },
    user: { id: 'm@x.org' },
  });
  assert.equal(doc.layerInfo.enhancedRelationLayer, null);

  await doc._reconcile();

  assert.deepEqual(calls, [
    ['create', 'lemma-layer', 'Enhanced Dependencies'],
    ['setConfig', 'enhanced-new', 'ud', 'enhancedDependency', true],
  ]);
  // Re-read, so the tree offers the gesture in the same sitting.
  assert.ok(doc.layerInfo.enhancedRelationLayer);
});

test('reconcile leaves the layers alone for anyone else, and where the layer exists', async () => {
  const calls = [];
  const bare = rawDocFromConllu(INPUT, 'e');
  const writer = new ConlluDocument({
    raw: bare,
    client: backfillClient(bare, calls),
    project: { maintainers: ['m@x.org'], writers: ['w@x.org'] },
    user: { id: 'w@x.org' },
  });
  await writer._reconcile();

  const full = rawDocFromConllu(INPUT, 'e', { enhanced: true });
  const maintainer = new ConlluDocument({
    raw: full,
    client: backfillClient(full, calls),
    project: { maintainers: ['m@x.org'] },
    user: { id: 'm@x.org' },
  });
  await maintainer._reconcile();

  assert.deepEqual(calls, []);
});
