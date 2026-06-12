// Exemplar tests for ConlluDocument's optimistic-mutation discipline, run
// offline against a stub client (see CLAUDE.md "Patterns to follow"):
//   - updates/deletes patch the LOCAL document BEFORE awaiting the server, so
//     the UI never flashes a stale value during the round trip;
//   - on a server failure, _withSaving reverts by refetching the document.
// The raw document comes from test/helpers/rawDoc.js; the client is a plain
// object with just the methods the mutation under test calls.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ConlluDocument } from '../src/domain/ConlluDocument.js';
import { rawDocFromConllu } from './helpers/rawDoc.js';

const INPUT = [
  '# text = del perro',
  '1-2\tdel\t_\t_\t_\t_\t_\t_\t_\t_',
  '1\tde\tde\tADP\t_\t_\t3\tcase\t_\t_',
  '2\tel\tel\tDET\t_\tDefinite=Def|PronType=Art\t3\tdet\t_\t_',
  '3\tperro\tperro\tNOUN\tNN\tGender=Masc|Number=Sing\t0\troot\t0:root\t_',
].join('\n');

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

const relationValue = (doc, relationId) =>
  doc.layerInfo.relationLayer.relations.find((r) => r.id === relationId)?.value;

test('updateRelation patches locally BEFORE the server responds', async () => {
  const raw = rawDocFromConllu(INPUT, 'mut-doc');
  const server = deferred();
  const client = { relations: { update: () => server.promise } };
  const doc = new ConlluDocument({ raw, client });

  const rel = doc.layerInfo.relationLayer.relations.find((r) => r.value === 'det');
  const pending = doc.updateRelation(rel.id, 'nsubj');

  // The optimistic patch is synchronous: the new value is visible while the
  // server call is still in flight.
  assert.equal(relationValue(doc, rel.id), 'nsubj');
  assert.equal(doc.isSaving, true);

  server.resolve({});
  assert.equal(await pending, true);
  assert.equal(relationValue(doc, rel.id), 'nsubj');
  assert.equal(doc.isSaving, false);
  assert.equal(doc.error, '');
});

test('updateRelation reverts via reload when the server rejects', async () => {
  const raw = rawDocFromConllu(INPUT, 'mut-doc');
  const pristine = structuredClone(raw);
  const client = {
    relations: { update: async () => { throw new Error('boom'); } },
    // _withSaving's failure path refetches the document; serve the pristine copy.
    documents: { get: async () => structuredClone(pristine) },
  };
  const doc = new ConlluDocument({ raw, client });

  const rel = doc.layerInfo.relationLayer.relations.find((r) => r.value === 'det');
  assert.equal(await doc.updateRelation(rel.id, 'nsubj'), false);

  assert.equal(relationValue(doc, rel.id), 'det'); // reverted
  assert.match(doc.error, /Failed to update relation/);
  assert.equal(doc.isSaving, false);
});

// --- Provenance: a human edit of a machine-made annotation verifies it -------
// (write contract rule 3: the edit also stamps provConfirmed, in one atomic
// batch with the value update, and the optimistic patch carries both).

const provClient = () => {
  const calls = [];
  return {
    calls,
    beginBatch() {},
    async submitBatch() { calls.push(['submitBatch']); return []; },
    spans: {
      update: (id, value) => { calls.push(['spans.update', id, value]); },
      patchMetadata: (id, body) => { calls.push(['spans.patchMetadata', id, body]); },
    },
    relations: {
      update: (id, value) => { calls.push(['relations.update', id, value]); },
      patchMetadata: (id, body) => { calls.push(['relations.patchMetadata', id, body]); },
    },
  };
};

test('editing a machine-made annotation verifies it (batched update + patchMetadata)', async () => {
  const raw = rawDocFromConllu(INPUT, 'mut-doc');
  const client = provClient();
  const doc = new ConlluDocument({ raw, client });

  const span = doc.layerInfo.uposLayer.spans.find((s) => s.value === 'NOUN');
  span.metadata = { prov: 'inferred', provSource: 'service:stanza-parser' };

  assert.equal(await doc.updateAnnotation(span.tokens[0], 'upos', 'PROPN'), true);
  assert.deepEqual(client.calls.map((c) => c[0]),
    ['spans.update', 'spans.patchMetadata', 'submitBatch']);
  assert.deepEqual(client.calls[1][2], { provConfirmed: true });

  // The optimistic patch carries value AND verified metadata together.
  const after = doc.layerInfo.uposLayer.spans.find((s) => s.id === span.id);
  assert.equal(after.value, 'PROPN');
  assert.equal(after.metadata.provConfirmed, true);
  assert.equal(after.metadata.provSource, 'service:stanza-parser'); // origin kept
});

test('editing a human annotation stays a plain update (no metadata write)', async () => {
  const raw = rawDocFromConllu(INPUT, 'mut-doc');
  const client = provClient();
  const doc = new ConlluDocument({ raw, client });

  const span = doc.layerInfo.uposLayer.spans.find((s) => s.value === 'NOUN');
  assert.equal(await doc.updateAnnotation(span.tokens[0], 'upos', 'PROPN'), true);
  assert.deepEqual(client.calls.map((c) => c[0]), ['spans.update']);
});

test('editing a machine-made relation verifies it too', async () => {
  const raw = rawDocFromConllu(INPUT, 'mut-doc');
  const client = provClient();
  const doc = new ConlluDocument({ raw, client });

  const rel = doc.layerInfo.relationLayer.relations.find((r) => r.value === 'det');
  rel.metadata = { prov: 'inferred', provSource: 'service:stanza-parser' };

  assert.equal(await doc.updateRelation(rel.id, 'nsubj'), true);
  assert.deepEqual(client.calls.map((c) => c[0]),
    ['relations.update', 'relations.patchMetadata', 'submitBatch']);
  const after = doc.layerInfo.relationLayer.relations.find((r) => r.id === rel.id);
  assert.equal(after.value, 'nsubj');
  assert.equal(after.metadata.provConfirmed, true);
});

test('deleteWord mirrors the server cascade locally before the round trip', async () => {
  const raw = rawDocFromConllu(INPUT, 'mut-doc');
  const server = deferred();
  const client = { tokens: { delete: () => server.promise } };
  const doc = new ConlluDocument({ raw, client });

  // Delete the word "perro" — the dependency head. Its morpheme, spans, and
  // every relation touching its Lemma span must vanish locally at once.
  const info = doc.layerInfo;
  const word = info.wordTokenLayer.tokens.find((w) => w.begin === 4);
  const pending = doc.deleteWord(word.id);

  const after = doc.layerInfo;
  assert.equal(after.wordTokenLayer.tokens.length, 1); // just "del"
  assert.equal(after.morphemeTokenLayer.tokens.length, 2); // de + el
  assert.deepEqual(after.lemmaLayer.spans.map((s) => s.value).sort(), ['de', 'el']);
  // All three relations involved perro's Lemma span (root self-loop + two heads).
  assert.equal(after.relationLayer.relations.length, 0);

  server.resolve({});
  assert.equal(await pending, true);
});
