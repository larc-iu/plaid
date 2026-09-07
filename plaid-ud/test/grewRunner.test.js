import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rawDocFromConllu } from './helpers/rawDoc.js';
import { withOps } from './helpers/stubClient.js';
import { getUdLayerInfo } from '../src/utils/udLayerUtils.js';
import { parseGrs } from '../src/grew/parser.js';
import { planRewrite, applyRewrite } from '../src/grew/rewrite/runner.js';

const CONLLU = [
  '# text = the dog saw a cat',
  '1\tthe\tthe\tDET\t_\tDefinite=Def\t2\tdet\t_\t_',
  '2\tdog\tdog\tNOUN\t_\t_\t3\tnsubj\t_\t_',
  '3\tsaw\t_\tVERB\t_\t_\t0\troot\t_\t_',
  '4\ta\ta\tDET\t_\tDefinite=Ind\t5\tdet\t_\t_',
  '5\tcat\tcat\tNOUN\t_\t_\t2\tnmod\t_\t_',
].join('\n');

// A recording client: every write lands in `calls` (and in the open batch,
// whose submit hands back a fresh id per op, as the server would).
function stubClient(raw) {
  const c = {
    calls: [],
    query: async () => ({ results: [[raw.id, 1]] }),
    documents: { get: async () => structuredClone(raw) },
    projects: { listDocuments: async () => [{ id: raw.id }] },
    beginBatch: () => {
      c._batch = [];
    },
    submitBatch: async () =>
      c._batch.map((call, i) => ({ status: 200, body: { id: `${call.op}-${i}` } })),
  };
  const rec =
    (op) =>
    (...args) => {
      const call = { op, args };
      c.calls.push(call);
      c._batch?.push(call);
    };
  c.tokens = { delete: rec('tokens.delete') };
  c.spans = {
    create: rec('spans.create'),
    update: rec('spans.update'),
    delete: rec('spans.delete'),
    patchMetadata: rec('spans.patchMetadata'),
  };
  c.relations = {
    create: rec('relations.create'),
    update: rec('relations.update'),
    delete: rec('relations.delete'),
    setSource: rec('relations.setSource'),
    setTarget: rec('relations.setTarget'),
    patchMetadata: rec('relations.patchMetadata'),
  };
  return withOps(c);
}

const setup = () => {
  const raw = rawDocFromConllu(CONLLU, 'doc1');
  // "a" was tagged by a parser: the verifier's rewrite confirms it.
  const aUpos = raw.textLayers[0].tokenLayers[2].spanLayers.find((l) => l.config.ud.upos).spans[3];
  aUpos.metadata = { prov: 'inferred', provSource: 'parser' };
  const client = stubClient(raw);
  const project = {
    id: 'p1',
    name: 'P',
    maintainers: [],
    writers: [],
    readers: [],
    textLayers: raw.textLayers,
  };
  return { raw, client, project, layerInfo: getUdLayerInfo(raw) };
};

test('plan: one row per rewritten sentence, with change lines and counts', async () => {
  const { client, project, layerInfo } = setup();
  const grs = parseGrs('pattern { X [upos=DET] } commands { X.upos = PRON }');
  const progress = [];
  const plan = await planRewrite(client, { project, user: null, layerInfo, grs }, (t) =>
    progress.push(t),
  );
  assert.equal(plan.documentsVisited, 1);
  assert.equal(plan.rows.length, 1);
  const [row] = plan.rows;
  assert.equal(row.docName, 'doc1');
  assert.equal(row.text, 'the dog saw a cat');
  assert.equal(row.applications, 2);
  assert.deepEqual(
    row.changes.map((c) => c.text),
    ['the: upos DET → PRON', 'a: upos DET → PRON'],
  );
  assert.equal(row.error, null);
  assert.deepEqual(progress, ['Loading document 1 of 1…', '']);
  assert.equal(client.calls.length, 0); // planning writes nothing
});

test('plan: a rule that fails on a sentence yields an error row, nothing else', async () => {
  const { client, project, layerInfo } = setup();
  const grs = parseGrs('pattern { X [upos=DET] } commands { X.upos = X.Number }');
  const plan = await planRewrite(client, { project, user: null, layerInfo, grs });
  assert.equal(plan.rows.length, 1);
  assert.match(plan.rows[0].error, /X.Number is undefined/);
  assert.equal(plan.rows[0].writes, null);
});

test('apply: updates carry the verifier stamp, all under one operation', async () => {
  const { client, project, layerInfo } = setup();
  const grs = parseGrs('pattern { X [upos=DET] } commands { X.upos = PRON }');
  const plan = await planRewrite(client, { project, user: null, layerInfo, grs });
  const out = await applyRewrite(client, { rows: plan.rows, docs: plan.docs, label: 'Rewrite' });
  assert.deepEqual(out, { docsChanged: 1, sentencesChanged: 1 });
  assert.deepEqual(
    client.calls.map((c) => c.op),
    ['spans.update', 'spans.update', 'spans.patchMetadata'],
  );
  assert.deepEqual(client.calls[1].args[1], 'PRON');
  // The machine-made tag is confirmed by the person's rewrite.
  assert.equal(client.calls[2].args[0], client.calls[1].args[0]);
  assert.equal(client.calls[2].args[1].provConfirmed, true);
});

test('apply: phases in order — token deletes, lemma creates, then relations on the new span', async () => {
  const { client, project, layerInfo } = setup();
  // "saw" has no lemma and so no relations; give it the nsubj and drop "the".
  const grs = parseGrs(`pattern { V [upos=VERB]; N [form="dog"]; D [form="the"] }
    commands { add_edge V -[nsubj]-> N; del_node D } strat main { rule }`);
  const plan = await planRewrite(client, { project, user: null, layerInfo, grs });
  assert.deepEqual(
    plan.rows[0].changes.map((c) => c.text),
    ['the: word deleted', 'saw → dog: nsubj added', 'saw: lemma saw added'],
  );
  await applyRewrite(client, { rows: plan.rows, docs: plan.docs, label: 'Rewrite' });
  assert.deepEqual(
    client.calls.map((c) => c.op),
    ['tokens.delete', 'spans.create', 'relations.create'],
  );
  const lemmaCreate = client.calls[1];
  assert.equal(lemmaCreate.args[2], 'saw');
  const relCreate = client.calls[2];
  assert.equal(relCreate.args[1], 'spans.create-0'); // the id the batch handed back
  assert.equal(relCreate.args[3], 'nsubj');
  // The surface token of a one-word token is what gets deleted.
  const theWord = plan.rows[0].nodes.get([...plan.rows[0].nodes.keys()][0]);
  assert.equal(client.calls[0].args[0], theWord.wordId);
});
