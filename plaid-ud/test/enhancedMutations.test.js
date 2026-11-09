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
      patchMetadata: async (id, body) => {
        log.push({ op: 'patch', id, body });
      },
      update: async (id, value) => {
        log.push({ op: 'update', id, value });
      },
      setSource: async (id, source) => {
        log.push({ op: 'source', id, source });
      },
    },
    spans: {
      delete: async (id) => {
        log.push({ op: 'delete-span', id });
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

  // Made under the id it was shown under, which this page minted.
  assert.equal(doc.layerInfo.enhancedRelationLayer.relations.at(-1).id, id);
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

// The tree's own edge under its own label is in the enhanced graph already,
// so it writes nothing (not a suppressor and its twin), labelled or not, as a
// Grew rewrite settles it (grew/rewrite/diff.js).
test('an enhanced edge with the tree label over a basic relation writes nothing', async () => {
  const { doc, log, lemma, rows, graph } = open();
  assert.equal(await doc.createEnhancedRelation(lemma('come'), lemma('leave')), null);
  assert.equal(await doc.createEnhancedRelation(lemma('come'), lemma('leave'), 'conj'), null);
  assert.deepEqual(log, []);
  assert.equal(rows().length, 0);
  assert.ok(graph().includes('come>leave:conj'));
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

// Leaving an edge out of the enhanced graph is a person's edit (R34): a
// reviewed contributor's suppressor is marked contributed, as their edges are.
test("a contributor's suppressor carries their stamp, in both ways of making one", async () => {
  const { client, log } = relationClient();
  const doc = new ConlluDocument({
    raw: rawDocFromConllu(INPUT, 'e', { enhanced: true }),
    client,
    project: { id: 'p', writers: ['ann@x'], config: { plaid: { review: { users: ['ann@x'] } } } },
    user: { id: 'ann@x', isAdmin: false },
  });
  const CONTRIBUTED = { prov: 'contributed', provSource: 'user:ann@x' };
  const obj = doc.layerInfo.relationLayer.relations.find((r) => r.value === 'obj');
  assert.equal(await doc.setRelationSuppressed(obj.id, true), true);
  assert.deepEqual(log.at(-1).metadata, { suppress: true, ...CONTRIBUTED });
  assert.deepEqual(doc.layerInfo.enhancedRelationLayer.relations.at(-1).metadata, {
    suppress: true,
    ...CONTRIBUTED,
  });
  const lemma = (value) => doc.layerInfo.lemmaLayer.spans.find((s) => s.value === value).id;
  await doc.createEnhancedRelation(lemma('come'), lemma('leave'), 'conj:and');
  assert.deepEqual(
    log.slice(-2).map((l) => [l.value, l.metadata]),
    [
      [null, { suppress: true, ...CONTRIBUTED }],
      ['conj:and', CONTRIBUTED],
    ],
  );
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

// A relabel (`obl` in the tree, `obl:on` in the graph, UD's own case-marked
// labels) is a suppressor and an extra over the tree's pair. A new head takes
// both along, so the word keeps its enhanced label under the new head (Luke,
// 2026-11-09, H2-2). Left behind, the extra became a second enhanced head.
const CASED = [
  '# text = We examine outcomes on land.',
  '1\tWe\twe\tPRON\t_\t_\t2\tnsubj\t2:nsubj\t_',
  '2\texamine\texamine\tVERB\t_\t_\t0\troot\t0:root\t_',
  '3\toutcomes\toutcome\tNOUN\t_\t_\t2\tobj\t2:obj\t_',
  '4\ton\ton\tADP\t_\t_\t5\tcase\t5:case\t_',
  '5\tland\tland\tNOUN\t_\t_\t2\tobl\t2:obl:on|4:dep\t_',
  '6\t.\t.\tPUNCT\t_\t_\t2\tpunct\t2:punct\t_',
].join('\n');

const depsOf = (doc, form) =>
  doc
    .toConllu()
    .split('\n')
    .find((l) => l.split('\t')[1] === form)
    .split('\t')
    .slice(6, 9)
    .join(' ');

test('a new head takes the relabelled enhanced edge along, in one write', async () => {
  const { doc, log, lemma, rows } = open(CASED);
  let batches = 0;
  const batched = doc._client.batched;
  doc._client.batched = (fn, o) => {
    batches += 1;
    return batched.call(doc._client, fn, o);
  };
  const [suppressor, extra] = ['suppress', 'obl:on'].map((v) =>
    rows().find((r) => (v === 'suppress' ? isSuppressor(r) : r.value === v)),
  );
  const second = rows().find((r) => r.value === 'dep');

  const write = doc.createRelation(lemma('outcome'), lemma('land'), 'obl');
  // Shown before the server answers, as every write is.
  assert.equal(depsOf(doc, 'land'), '3 obl 3:obl:on|4:dep');
  await write;

  assert.equal(depsOf(doc, 'land'), '3 obl 3:obl:on|4:dep');
  assert.equal(batches, 1);
  // Moved, not deleted and made again: the rows keep their ids.
  assert.deepEqual(
    log.filter((l) => l.op === 'source').map((l) => [l.id, l.source]),
    [
      [suppressor.id, lemma('outcome')],
      [extra.id, lemma('outcome')],
    ],
  );
  assert.ok(!log.some((l) => l.op === 'delete' && [suppressor.id, extra.id].includes(l.id)));
  // A second enhanced head of its own stays where it was.
  assert.equal(rows().find((r) => r.id === second.id).source, lemma('on'));
});

test('a new head that is the root takes the relabel along too', async () => {
  const { doc, lemma } = open(CASED);
  await doc.createRelation(lemma('land'), lemma('land'), 'root');
  assert.equal(depsOf(doc, 'land'), '0 root 0:obl:on|4:dep');
});

test('the same head drawn again keeps the relabel', async () => {
  const { doc, lemma } = open(CASED);
  await doc.createRelation(lemma('examine'), lemma('land'), 'obl');
  assert.equal(depsOf(doc, 'land'), '2 obl 2:obl:on|4:dep');
});

test('a word simply left out of the graph rejoins it under a new head', async () => {
  // A suppressor with no extra beside it is no relabel: it goes with its
  // tree relation, as before.
  const LEFT_OUT = CASED.replace('2:obl:on|4:dep', '_');
  const { doc, lemma, rows } = open(LEFT_OUT);
  assert.equal(rows().filter(isSuppressor).length, 1);
  await doc.createRelation(lemma('outcome'), lemma('land'), 'obl');
  assert.equal(depsOf(doc, 'land'), '3 obl 3:obl');
  assert.deepEqual(rows(), []);
});

test("a moved machine relabel becomes the writer's, as a re-pointed head does", async () => {
  const { doc, log, lemma, rows } = open(CASED);
  const extra = rows().find((r) => r.value === 'obl:on');
  extra.metadata = { prov: 'inferred', provSource: 'service:stanza-parser' };
  await doc.createRelation(lemma('outcome'), lemma('land'), 'obl');
  assert.equal(rows().find((r) => r.id === extra.id).metadata.prov, undefined);
  assert.ok(log.some((l) => l.op === 'patch' && l.id === extra.id));
});

test('a drag and a Grew rule that move a head take the relabel along alike', async () => {
  const { doc: byHand, lemma } = open(CASED);
  await byHand.createRelation(lemma('outcome'), lemma('land'), 'obl');

  const byRule = new ConlluDocument({ raw: rawDocFromConllu(CASED, 'e', { enhanced: true }) });
  const before = graphFromSentence(byRule.sentences[0]);
  const { graph: after, applications } = rewriteSentence(
    parseGrs(
      'pattern { V [lemma="examine"]; H [lemma="outcome"]; V -[obl]-> W } commands { shift_out V =[obl]=> H }',
    ),
    before,
  );
  assert.equal(applications.length, 1);
  const { writes, errors } = diffGraphs(before, after, byRule.layerInfo);
  assert.deepEqual(errors, []);
  // The writes applied as the runner sends them, rows found by id, words
  // named by their lemma span.
  const li = byRule.layerInfo;
  const lemmaOf = new Map(li.lemmaLayer.spans.map((s) => [s.tokens[0], s.id]));
  const layers = [li.relationLayer, li.enhancedRelationLayer];
  const find = (id) => layers.flatMap((l) => l.relations).find((r) => r.id === id);
  let made = 0;
  for (const w of writes.main) {
    if (w.op === 'setSource') find(w.id).source = lemmaOf.get(w.node);
    else if (w.op === 'setTarget') find(w.id).target = lemmaOf.get(w.node);
    else if (w.op === 'deleteRelation')
      for (const l of layers) l.relations = l.relations.filter((r) => r.id !== w.id);
    else if (w.op === 'createRelation')
      layers
        .find((l) => l.id === w.layer)
        .relations.push({
          id: `w-${made++}`,
          source: lemmaOf.get(w.src),
          target: lemmaOf.get(w.tgt),
          value: w.value,
          ...(w.metadata ? { metadata: w.metadata } : {}),
        });
    else throw new Error(`no ${w.op} here`);
  }

  assert.deepEqual(graphOf(byRule), graphOf(byHand));
  assert.ok(graphOf(byRule).includes('outcome>land:obl:on'));
  assert.ok(!graphOf(byRule).includes('examine>land:obl:on'));
  assert.ok(!graphOf(byRule).includes('outcome>land:obl'));
});

test('a relation drawn over a pair someone else left a suppressor on is not born faded', async () => {
  // The other direction of the same guard, and the one that covers writers
  // outside this editor: an agent `set_head`, a script or the Python client
  // moves a basic relation and leaves the suppressor over the pair it left
  // behind. Nothing sweeps those, and the assistant panel is
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

test('the band relabels an extra without touching the tree', async () => {
  const { doc, log, lemma, basic, rows, graph } = open();
  const id = await doc.createEnhancedRelation(lemma('come'), lemma('she'), 'nsubj:xsubj');

  assert.equal(await doc.updateRelation(id, 'nsubj:pass'), true);
  assert.equal(rows().find((r) => r.id === id).value, 'nsubj:pass');
  assert.equal(basic('nsubj').value, 'nsubj');
  assert.ok(graph().includes('come>she:nsubj:pass'));
  assert.deepEqual(log.at(-1), { op: 'update', id, value: 'nsubj:pass' });
});

test('relabelling a machine extra verifies it, as an edit of any machine value does', async () => {
  const { doc, log, lemma, rows } = open();
  const id = await doc.createEnhancedRelation(lemma('leave'), lemma('she'), 'nsubj');
  rows().find((r) => r.id === id).metadata = {
    prov: 'inferred',
    provSource: 'service:stanza-parser',
  };

  assert.equal(await doc.updateRelation(id, 'nsubj:xsubj'), true);
  assert.equal(rows().find((r) => r.id === id).metadata.provConfirmed, true);
  assert.deepEqual(
    log.slice(-2).map((l) => l.op),
    ['update', 'patch'],
  );
});

test('discarding a machine relation takes the suppressor lying over it', async () => {
  const { doc, log, basic, rows } = open();
  const obj = basic('obj');
  obj.metadata = { prov: 'inferred', provSource: 'service:stanza-parser' };
  await doc.setRelationSuppressed(obj.id, true);
  assert.equal(rows().length, 1);

  // "home" is the dependent of that relation.
  const home = doc.layerInfo.lemmaLayer.spans.find((s) => s.value === 'home').tokens[0];
  assert.equal(await doc.discardTokens([home]), true);

  assert.deepEqual(rows(), []);
  assert.deepEqual(
    log
      .filter((l) => l.op === 'delete')
      .map((l) => l.id)
      .sort(),
    [obj.id, 'new-0'].sort(),
  );
});

test("a sentence split leaves the edges it cuts to the server's rule, and takes them off the screen", async () => {
  const { client } = relationClient();
  const deleted = [];
  const splits = [];
  client.tokens = {
    split: async (...args) => {
      splits.push(args);
      return { id: 'sent-right' };
    },
  };
  client.relations.delete = async (id) => deleted.push(id);
  const raw = rawDocFromConllu(INPUT, 'e', { enhanced: true });
  const doc = new ConlluDocument({ raw, client });
  const lemma = (v) => doc.layerInfo.lemmaLayer.spans.find((s) => s.value === v).id;
  await doc.createEnhancedRelation(lemma('leave'), lemma('she'), 'nsubj');

  // Split before "and": she | came  //  and left home.
  const and = doc.layerInfo.wordTokenLayer.tokens[2];
  assert.equal(await doc.toggleSentenceBoundary(and.begin), true);

  // One bare split. The server's same-ancestor rule drops what crosses, from
  // what it has stored, in the split's own transaction.
  assert.equal(splits.length, 1);
  const { id: rightId, ...splitOptions } = splits[0][3];
  assert.deepEqual(splitOptions, {});
  // The right half is made under the id it was shown under.
  assert.equal(typeof rightId, 'string');
  assert.deepEqual(deleted, []);
  assert.deepEqual(doc.layerInfo.enhancedRelationLayer.relations, []);
  // The basic conj(come, leave) crossed too, as it always has.
  assert.equal(
    doc.layerInfo.relationLayer.relations.some((r) => r.value === 'conj'),
    false,
  );
});

test('an enhanced edge and the suppressor it lays are created under the ids they were shown under', async () => {
  const sent = [];
  const client = withOps({
    relations: {
      create: async (layerId, source, target, value, metadata, auditMessage, opts) => {
        sent.push({ value, id: opts?.id });
        return { id: opts?.id };
      },
    },
  });
  const doc = new ConlluDocument({ raw: rawDocFromConllu(INPUT, 'e', { enhanced: true }), client });
  const lemma = (value) => doc.layerInfo.lemmaLayer.spans.find((s) => s.value === value).id;
  const shown = [];
  const write = doc.createEnhancedRelation(lemma('come'), lemma('she'), 'nsubj:pass');
  shown.push(...doc.layerInfo.enhancedRelationLayer.relations.map((r) => r.id));
  const id = await write;

  assert.deepEqual(
    sent.map((s) => s.value),
    [null, 'nsubj:pass'],
  );
  assert.deepEqual(
    sent.map((s) => s.id),
    shown,
  );
  assert.equal(id, shown[1]);
  assert.deepEqual(
    doc.layerInfo.enhancedRelationLayer.relations.map((r) => r.id),
    shown,
  );
});
