// Every write shows before the server answers, creates included. The client
// here holds every create until the test lets it through, so what the document
// shows in between is what a person sees while the round trip is in flight.
// This has regressed more than once, each time to "wait for the server's id".
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ConlluDocument } from '../src/domain/ConlluDocument.js';
import { isPendingId } from '../src/domain/pendingIds.js';
import { rawDocFromConllu } from './helpers/rawDoc.js';
import { withOps } from './helpers/stubClient.js';

// Word 6 has no head and no lemma, so it has no lemma span yet.
const INPUT = [
  '# text = she came and left home .',
  '1\tshe\tshe\tPRON\t_\t_\t2\tnsubj\t_\t_',
  '2\tcame\tcome\tVERB\t_\t_\t0\troot\t_\t_',
  '3\tand\tand\tCCONJ\t_\t_\t4\tcc\t_\t_',
  '4\tleft\tleave\tVERB\t_\t_\t2\tconj\t_\t_',
  '5\thome\thome\tNOUN\t_\t_\t4\tobj\t_\t_',
  '6\t.\t_\t_\t_\t_\t_\t_\t_\t_',
].join('\n');

// A client whose creates wait on `release()`. Batches wait too.
const heldClient = () => {
  let n = 0;
  let open;
  let gate = new Promise((resolve) => (open = resolve));
  const held = async (value) => {
    await gate;
    return value;
  };
  const client = withOps({
    relations: {
      create: () => held({ id: `rel-${n++}` }),
      delete: async () => {},
      update: async () => {},
      patchMetadata: async () => {},
    },
    spans: {
      create: () => held({ id: `span-${n++}` }),
      delete: async () => {},
      update: async () => {},
      patchMetadata: async () => {},
    },
  });
  const release = () => {
    open();
    gate = Promise.resolve();
  };
  return { client, release };
};

const open = () => {
  const { client, release } = heldClient();
  const doc = new ConlluDocument({ raw: rawDocFromConllu(INPUT, 'o', { enhanced: true }), client });
  const lemma = (value) => doc.layerInfo.lemmaLayer.spans.find((s) => s.value === value)?.id;
  const token = (form) => {
    const body = doc.layerInfo.textLayer.text.body;
    return doc.layerInfo.tokenLayer.tokens.find(
      (t) => [...body].slice(t.begin, t.end).join('') === form,
    ).id;
  };
  const headOf = (spanId) =>
    doc.layerInfo.relationLayer.relations.filter((r) => r.target === spanId);
  return { doc, release, lemma, token, headOf };
};

// Let the write run up to the first held call.
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('a re-pointed head shows before the server answers', async () => {
  const { doc, release, lemma, headOf } = open();
  const write = doc.createRelation(lemma('come'), lemma('home'), 'obj');
  await settle();

  const [shown] = headOf(lemma('home'));
  assert.equal(headOf(lemma('home')).length, 1);
  assert.equal(shown.source, lemma('come'));
  assert.ok(isPendingId(shown.id));

  release();
  assert.equal(await write, true);
  const [saved] = headOf(lemma('home'));
  assert.equal(saved.source, lemma('come'));
  assert.ok(!isPendingId(saved.id), 'the server id never replaced the pending one');
});

test('a relation to a word with no lemma span shows both before the server answers', async () => {
  const { doc, release, lemma, token } = open();
  const dot = token('.');
  const write = doc.createRelation(lemma('come'), dot, 'punct');
  await settle();

  const span = doc.layerInfo.lemmaLayer.spans.find((s) => s.tokens.includes(dot));
  assert.ok(span, 'the word has no lemma span while the write is in flight');
  const rel = doc.layerInfo.relationLayer.relations.find((r) => r.target === span.id);
  assert.equal(rel?.value, 'punct');

  release();
  assert.equal(await write, true);
  const savedSpan = doc.layerInfo.lemmaLayer.spans.find((s) => s.tokens.includes(dot));
  const savedRel = doc.layerInfo.relationLayer.relations.find((r) => r.target === savedSpan.id);
  assert.ok(!isPendingId(savedSpan.id));
  assert.ok(!isPendingId(savedRel.id));
  assert.equal(savedRel.source, lemma('come'));
});

test('an enhanced edge shows before the server answers', async () => {
  const { doc, release, lemma } = open();
  const rows = () => doc.layerInfo.enhancedRelationLayer.relations;
  const write = doc.createEnhancedRelation(lemma('leave'), lemma('she'), 'nsubj');
  await settle();

  assert.equal(rows().length, 1);
  assert.ok(isPendingId(rows()[0].id));

  release();
  const id = await write;
  assert.equal(rows()[0].id, id);
  assert.ok(!isPendingId(id));
});

test('a new cell value shows before the server answers', async () => {
  const { doc, release, token } = open();
  const dot = token('.');
  const upos = () => doc.layerInfo.uposLayer.spans.find((s) => s.tokens.includes(dot));
  const write = doc.updateAnnotation(dot, 'upos', 'PUNCT');
  await settle();

  assert.equal(upos()?.value, 'PUNCT');

  release();
  assert.equal(await write, true);
  assert.ok(!isPendingId(upos().id));
});
