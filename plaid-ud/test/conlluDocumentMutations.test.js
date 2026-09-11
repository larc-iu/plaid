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
import { withOps } from './helpers/stubClient.js';

const INPUT = [
  '# text = del perro',
  '1-2\tdel\t_\t_\t_\t_\t_\t_\t_\t_',
  '1\tde\tde\tADP\t_\t_\t3\tcase\t_\t_',
  '2\tel\tel\tDET\t_\tDefinite=Def|PronType=Art\t3\tdet\t_\t_',
  '3\tperro\tperro\tNOUN\tNN\tGender=Masc|Number=Sing\t0\troot\t0:root\t_',
].join('\n');

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const relationValue = (doc, relationId) =>
  doc.layerInfo.relationLayer.relations.find((r) => r.id === relationId)?.value;

test('updateRelation patches locally BEFORE the server responds', async () => {
  const raw = rawDocFromConllu(INPUT, 'mut-doc');
  const server = deferred();
  const client = { relations: { update: () => server.promise } };
  const doc = new ConlluDocument({ raw, client: withOps(client) });

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
    relations: {
      update: async () => {
        throw new Error('boom');
      },
    },
    // _withSaving's failure path refetches the document; serve the pristine copy.
    documents: { get: async () => structuredClone(pristine) },
  };
  const doc = new ConlluDocument({ raw, client: withOps(client) });

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
  const client = {
    calls,
    beginBatch() {},
    async submitBatch() {
      calls.push(['submitBatch']);
      return [];
    },
    spans: {
      update: (id, value) => {
        calls.push(['spans.update', id, value]);
      },
      patchMetadata: (id, body) => {
        calls.push(['spans.patchMetadata', id, body]);
      },
    },
    relations: {
      update: (id, value) => {
        calls.push(['relations.update', id, value]);
      },
      patchMetadata: (id, body) => {
        calls.push(['relations.patchMetadata', id, body]);
      },
      delete: (id) => {
        calls.push(['relations.delete', id]);
      },
    },
  };
  client.spans.delete = (id) => {
    calls.push(['spans.delete', id]);
  };
  return client;
};

test('editing a machine-made annotation verifies it (batched update + patchMetadata)', async () => {
  const raw = rawDocFromConllu(INPUT, 'mut-doc');
  const client = provClient();
  const doc = new ConlluDocument({ raw, client: withOps(client) });

  const span = doc.layerInfo.uposLayer.spans.find((s) => s.value === 'NOUN');
  span.metadata = { prov: 'inferred', provSource: 'service:stanza-parser' };

  assert.equal(await doc.updateAnnotation(span.tokens[0], 'upos', 'PROPN'), true);
  assert.deepEqual(
    client.calls.map((c) => c[0]),
    ['spans.update', 'spans.patchMetadata', 'submitBatch'],
  );
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
  const doc = new ConlluDocument({ raw, client: withOps(client) });

  const span = doc.layerInfo.uposLayer.spans.find((s) => s.value === 'NOUN');
  assert.equal(await doc.updateAnnotation(span.tokens[0], 'upos', 'PROPN'), true);
  assert.deepEqual(
    client.calls.map((c) => c[0]),
    ['spans.update'],
  );
});

test('editing a machine-made relation verifies it too', async () => {
  const raw = rawDocFromConllu(INPUT, 'mut-doc');
  const client = provClient();
  const doc = new ConlluDocument({ raw, client: withOps(client) });

  const rel = doc.layerInfo.relationLayer.relations.find((r) => r.value === 'det');
  rel.metadata = { prov: 'inferred', provSource: 'service:stanza-parser' };

  assert.equal(await doc.updateRelation(rel.id, 'nsubj'), true);
  assert.deepEqual(
    client.calls.map((c) => c[0]),
    ['relations.update', 'relations.patchMetadata', 'submitBatch'],
  );
  const after = doc.layerInfo.relationLayer.relations.find((r) => r.id === rel.id);
  assert.equal(after.value, 'nsubj');
  assert.equal(after.metadata.provConfirmed, true);
});

// A CONTRIBUTOR (someone the project's plaid.review lists name) writes as the
// provenance convention's rule 3 says for them: creates and edits carry the
// contributed stamp, an edit of a confirmed value drops the confirmation, and
// their acceptance of a machine proposal is a contribution, not a verification.
const CONTRIBUTED = { prov: 'contributed', provSource: 'user:ann@x.com' };
const reviewedProject = {
  id: 'p',
  writers: ['ann@x.com'],
  config: { plaid: { review: { users: ['ann@x.com'] } } },
};
const asAnn = (raw, client) =>
  new ConlluDocument({
    raw,
    client: withOps(client),
    project: reviewedProject,
    user: { id: 'ann@x.com', isAdmin: false },
  });

test("a contributor's edit of a confirmed machine annotation marks it contributed", async () => {
  const raw = rawDocFromConllu(INPUT, 'mut-doc');
  const client = provClient();
  const doc = asAnn(raw, client);
  assert.equal(doc.contributorId, 'ann@x.com');

  const span = doc.layerInfo.uposLayer.spans.find((s) => s.value === 'NOUN');
  span.metadata = { prov: 'inferred', provSource: 'service:stanza-parser', provConfirmed: true };

  assert.equal(await doc.updateAnnotation(span.tokens[0], 'upos', 'PROPN'), true);
  assert.deepEqual(
    client.calls.map((c) => c[0]),
    ['spans.update', 'spans.patchMetadata', 'submitBatch'],
  );
  assert.deepEqual(client.calls[1][2], { ...CONTRIBUTED, provConfirmed: null });
  const after = doc.layerInfo.uposLayer.spans.find((s) => s.id === span.id);
  assert.equal(after.value, 'PROPN');
  assert.deepEqual(after.metadata, CONTRIBUTED); // the local copy drops the null key too
});

test("a contributor's edit of a plain annotation marks it contributed; a verifier's edit of contributed work confirms it", async () => {
  const raw = rawDocFromConllu(INPUT, 'mut-doc');
  const client = provClient();
  const doc = asAnn(raw, client);
  const span = doc.layerInfo.uposLayer.spans.find((s) => s.value === 'NOUN');
  assert.equal(await doc.updateAnnotation(span.tokens[0], 'upos', 'PROPN'), true);
  assert.deepEqual(client.calls[1][2], { ...CONTRIBUTED, provConfirmed: null });

  const verifier = new ConlluDocument({
    raw: rawDocFromConllu(INPUT, 'mut-doc'),
    client: withOps(provClient()),
    project: reviewedProject,
    user: { id: 'lead@x.com', isAdmin: false },
  });
  assert.equal(verifier.contributorId, null);
  const span2 = verifier.layerInfo.uposLayer.spans.find((s) => s.value === 'NOUN');
  span2.metadata = { ...CONTRIBUTED };
  assert.equal(await verifier.updateAnnotation(span2.tokens[0], 'upos', 'PROPN'), true);
  const after = verifier.layerInfo.uposLayer.spans.find((s) => s.id === span2.id);
  assert.deepEqual(after.metadata, { ...CONTRIBUTED, provConfirmed: true });
});

test('confirmTokens: a contributor takes machine proposals as contributions and leaves contributed work alone', async () => {
  const raw = rawDocFromConllu(INPUT, 'mut-doc');
  const client = provClient();
  const doc = asAnn(raw, client);
  const noun = doc.layerInfo.uposLayer.spans.find((s) => s.value === 'NOUN');
  noun.metadata = { prov: 'inferred', provSource: 'service:stanza-parser' };
  const det = doc.layerInfo.uposLayer.spans.find((s) => s.value === 'DET');
  det.metadata = { ...CONTRIBUTED };

  assert.equal(await doc.confirmTokens([...noun.tokens, ...det.tokens]), true);
  const patches = client.calls.filter((c) => c[0] === 'spans.patchMetadata');
  assert.deepEqual(
    patches.map((c) => c[1]),
    [noun.id],
  );
  assert.deepEqual(patches[0][2], { ...CONTRIBUTED, provConfirmed: null });
  assert.deepEqual(
    doc.layerInfo.uposLayer.spans.find((s) => s.id === noun.id).metadata,
    CONTRIBUTED,
  );
});

test('discardTokens deletes the machine proposal and leaves everything else', async () => {
  const raw = rawDocFromConllu(INPUT, 'mut-doc');
  const client = provClient();
  const doc = new ConlluDocument({ raw, client: withOps(client) });

  const machine = { prov: 'inferred', provSource: 'service:stanza-parser' };
  const noun = doc.layerInfo.uposLayer.spans.find((s) => s.value === 'NOUN');
  noun.metadata = { ...machine };
  const nnXpos = doc.layerInfo.xposLayer.spans.find((s) => s.value === 'NN');
  nnXpos.metadata = { ...machine, provConfirmed: true }; // somebody vouched
  const det = doc.layerInfo.uposLayer.spans.find((s) => s.value === 'DET');
  det.metadata = { ...CONTRIBUTED };

  // Every word in one gesture: only the plain machine span goes.
  const everyToken = doc.sentences.flatMap((sent) => sent.tokens.map((t) => t.token.id));
  assert.equal(await doc.discardTokens(everyToken), true);
  assert.deepEqual(
    client.calls.filter((c) => c[0] === 'spans.delete').map((c) => c[1]),
    [noun.id],
  );
  const uposLeft = doc.layerInfo.uposLayer.spans.map((s) => s.value);
  assert.ok(!uposLeft.includes('NOUN'));
  assert.ok(uposLeft.includes('DET'));
  assert.ok(doc.layerInfo.xposLayer.spans.some((s) => s.id === nnXpos.id));
});

test('discardTokens takes a machine relation but keeps a lemma span a human relation hangs on', async () => {
  const raw = rawDocFromConllu(INPUT, 'mut-doc');
  const client = provClient();
  const doc = new ConlluDocument({ raw, client: withOps(client) });

  const machine = { prov: 'inferred', provSource: 'service:stanza-parser' };
  // 'de' is the dependent of a `case` relation. Make both its lemma span and
  // that relation the parser's.
  const deLemma = doc.layerInfo.lemmaLayer.spans.find((s) => s.value === 'de');
  deLemma.metadata = { ...machine };
  const caseRel = doc.layerInfo.relationLayer.relations.find((r) => r.value === 'case');
  caseRel.metadata = { ...machine };
  const deToken = deLemma.tokens[0];

  assert.equal(await doc.discardTokens([deToken]), true);
  assert.deepEqual(
    client.calls.filter((c) => c[0] === 'relations.delete').map((c) => c[1]),
    [caseRel.id],
  );
  assert.deepEqual(
    client.calls.filter((c) => c[0] === 'spans.delete').map((c) => c[1]),
    [deLemma.id],
  );
  // Relations go before spans: a relation whose anchor is already gone is gone,
  // and deleting it twice is a 404.
  const order = client.calls.filter((c) => c[0].endsWith('.delete')).map((c) => c[0]);
  assert.deepEqual(order, ['relations.delete', 'spans.delete']);
});

test('discardTokens spares a machine lemma span that a human relation still hangs on', async () => {
  const raw = rawDocFromConllu(INPUT, 'mut-doc');
  const client = provClient();
  const doc = new ConlluDocument({ raw, client: withOps(client) });

  const machine = { prov: 'inferred', provSource: 'service:stanza-parser' };
  const deLemma = doc.layerInfo.lemmaLayer.spans.find((s) => s.value === 'de');
  deLemma.metadata = { ...machine };
  // Its incoming relation is a person's: deleting the lemma span would cascade
  // that relation away, which is the one way this gesture could destroy work.
  const deToken = deLemma.tokens[0];

  assert.equal(await doc.discardTokens([deToken]), true);
  assert.deepEqual(
    client.calls.filter((c) => c[0] === 'spans.delete').map((c) => c[1]),
    [],
  );
  assert.ok(doc.layerInfo.lemmaLayer.spans.some((s) => s.id === deLemma.id));
});

test("discardTokens leaves a contributor's work alone, for a verifier too", async () => {
  const raw = rawDocFromConllu(INPUT, 'mut-doc');
  const client = provClient();
  const doc = new ConlluDocument({ raw, client: withOps(client) });
  const det = doc.layerInfo.uposLayer.spans.find((s) => s.value === 'DET');
  det.metadata = { ...CONTRIBUTED };

  // Nothing machine-made anywhere, so the gesture is a no-op and says so.
  const everyToken = doc.sentences.flatMap((sent) => sent.tokens.map((t) => t.token.id));
  assert.equal(await doc.discardTokens(everyToken), true);
  assert.deepEqual(
    client.calls.filter((c) => c[0].endsWith('.delete')),
    [],
  );
  assert.ok(doc.layerInfo.uposLayer.spans.some((s) => s.id === det.id));
});

test('deleteWord mirrors the server cascade locally before the round trip', async () => {
  const raw = rawDocFromConllu(INPUT, 'mut-doc');
  const server = deferred();
  const client = { tokens: { delete: () => server.promise } };
  const doc = new ConlluDocument({ raw, client: withOps(client) });

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
