// A triple between two constants belongs to no sentence by itself: the
// records of the sentences whose blocks write it list it. The canvas puts it
// there as it makes it, in the request that makes it, so it never stands on
// a sentence number that another app's edit before it would make wrong, and
// an open has nothing to move.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyMetadataOps } from '@larc-iu/plaid-client';
import { parseUmrFile } from '../src/domain/format/umrFile.js';
import { planImport } from '../src/domain/umrImport.js';
import { UmrDocument } from '../src/domain/UmrDocument.js';
import { rawFromPlan } from './rawFromPlan.js';
import { recordingClient } from './recordingClient.js';

const SEP = '#'.repeat(80);
const block = (n) => `${SEP}
# :: snt${n}
Index: 1 2 3
Words: Ali geldi .

# sentence level graph:
(s${n}g / gel-01
    :ARG1 (s${n}a / person))

# alignment:
s${n}g: 2-2
s${n}a: 1-1

# document level annotation:
(s${n}s0 / sentence)
`;

const nodeLayer = (raw) => raw.textLayers[0].tokenLayers.find((l) => l.config?.umr?.nodes);
const records = (raw) =>
  nodeLayer(raw)
    .tokens.filter((t) => t.metadata?.umr)
    .sort((a, b) => a.begin - b.begin);

// What the server holds after the calls, as it would store them: rows under
// the ids the page minted.
function replay(raw, calls) {
  const next = structuredClone(raw);
  const layer = nodeLayer(next);
  const tokens = layer.tokens;
  const spans = layer.spanLayers[0].spans;
  const triples = layer.spanLayers[0].relationLayers.find((l) => l.config?.umr?.documentGraph);
  calls.forEach(({ name, args }) => {
    if (name === 'tokens.bulkCreate') {
      args[0].forEach((t) =>
        tokens.push({ id: t.id, begin: t.begin, end: t.end, metadata: t.metadata }),
      );
    } else if (name === 'tokens.patchMetadata') {
      const t = tokens.find((x) => x.id === args[0]);
      t.metadata = applyMetadataOps(t.metadata || {}, args[1]);
    } else if (name === 'spans.create') {
      spans.push({ id: args[5].id, tokens: args[1], value: args[2], metadata: args[3] });
    } else if (name === 'relations.create') {
      triples.relations.push({
        id: args[6].id,
        source: args[1],
        target: args[2],
        value: args[3],
        metadata: args[4],
      });
    }
  });
  return next;
}

function load(edit = null) {
  const raw = rawFromPlan(
    planImport(parseUmrFile(`${block(1)}\n${block(2)}\n${block(3)}`).sentences, []),
  );
  if (edit) edit(raw);
  const { client, calls, requests } = recordingClient();
  // As the server answers: every row under the id the page minted, so a
  // ref names what a replay of the calls stores.
  client.tokens.bulkCreate = async (ops) => {
    calls.push({ name: 'tokens.bulkCreate', args: [ops] });
    return { ids: ops.map((o) => o.id) };
  };
  client.spans.create = async (...args) => {
    calls.push({ name: 'spans.create', args });
    return { id: args[5].id };
  };
  client.relations.create = async (...args) => {
    calls.push({ name: 'relations.create', args });
    return { id: args[6].id };
  };
  const doc = new UmrDocument({ raw, client });
  doc._reload = async () => {};
  doc.onError = (msg) => {
    throw new Error(msg);
  };
  return { doc, raw, calls, requests };
}

const blocksOf = (doc, tripleId) =>
  doc.graph.sentences.filter((s) => s.triples.some((t) => t.id === tripleId)).map((s) => s.index);

test('a triple between constants is listed in its sentence record in the request that makes it', async () => {
  const { doc, raw, calls, requests } = load();
  const record = records(raw)[1];
  const made = doc.createTriple({
    source: 'root',
    target: 'author',
    rel: ':modal',
    sentenceIndex: 2,
  });
  // Shown in its block at once.
  const shown = doc.graph.constants.flatMap((c) => c.docOut)[0];
  assert.deepEqual(blocksOf(doc, shown.id), [2]);
  assert.ok(await made);
  assert.equal(requests.length, 1, 'one request');
  const create = calls.find((c) => c.name === 'relations.create');
  const tripleId = create.args[6].id;
  assert.equal(tripleId, shown.id);
  assert.deepEqual(create.args[4].umr, { group: 'modal' }, 'no sentence number is stored');
  assert.deepEqual(
    calls.filter((c) => c.name === 'tokens.patchMetadata').map((c) => c.args),
    [[record.id, [{ op: 'set', path: ['umr', 'triples'], value: [tripleId] }]]],
  );
  // Read again from what was written: the same block, and nothing to repair.
  const after = new UmrDocument({ raw: replay(raw, calls), client: recordingClient().client });
  after._reload = async () => {};
  assert.deepEqual(blocksOf(after, tripleId), [2]);
  assert.deepEqual(await after._reconcile(), { findings: [] });
});

test('a second triple in the same block keeps the first in the record', async () => {
  const { doc, raw, calls } = load();
  const record = records(raw)[0];
  assert.ok(await doc.createTriple({ source: 'root', target: 'author', rel: ':modal' }));
  assert.ok(await doc.createTriple({ source: 'author', target: 'root', rel: ':full-affirmative' }));
  const ids = calls.filter((c) => c.name === 'relations.create').map((c) => c.args[6].id);
  const patches = calls.filter((c) => c.name === 'tokens.patchMetadata');
  assert.deepEqual(patches.at(-1).args, [
    record.id,
    [{ op: 'set', path: ['umr', 'triples'], value: ids }],
  ]);
  const after = new UmrDocument({ raw: replay(raw, calls), client: recordingClient().client });
  ids.forEach((id) => assert.deepEqual(blocksOf(after, id), [1]));
});

test('a sentence with no record gets one over the sentence, in the same request', async () => {
  const { doc, raw, calls, requests } = load((r) => {
    const third = records(r)[2];
    nodeLayer(r).tokens = nodeLayer(r).tokens.filter((t) => t !== third);
  });
  const sentence = doc.sentence(3);
  assert.equal(sentence.recordToken, null);
  assert.ok(
    await doc.createTriple({ source: 'root', target: 'author', rel: ':modal', sentenceIndex: 3 }),
  );
  assert.equal(requests.length, 1);
  const tripleId = calls.find((c) => c.name === 'relations.create').args[6].id;
  const made = calls
    .filter((c) => c.name === 'tokens.bulkCreate')
    .flatMap((c) => c.args[0])
    .filter((t) => t.metadata?.umr);
  assert.equal(made.length, 1);
  assert.deepEqual(made[0].metadata, { umr: { triples: [tripleId] } });
  assert.deepEqual([made[0].begin, made[0].end], [sentence.begin, sentence.end]);
  const after = new UmrDocument({ raw: replay(raw, calls), client: recordingClient().client });
  after._reload = async () => {};
  assert.deepEqual(blocksOf(after, tripleId), [3]);
  assert.deepEqual(await after._reconcile(), { findings: [] });
});

test('a triple with a node at one end is listed in no record', async () => {
  const { doc, calls } = load();
  const node = doc.sentence(2).nodes[0];
  assert.ok(await doc.createTriple({ source: node.id, target: 'author', rel: ':modal' }));
  assert.equal(calls.filter((c) => c.name === 'tokens.patchMetadata').length, 0);
});
