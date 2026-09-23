// Every write shows before the server answers, creates included. The client
// here holds every create until the test lets it through, so what the document
// shows in between is what a person sees while the round trip is in flight.
// This has regressed more than once, each time to "wait for the server's id".
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ConlluDocument } from '../src/domain/ConlluDocument.js';
import { isPendingId } from '../../plaid-ui/src/domain/pendingIds.js';
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

// A client whose every write waits on `release()`, and records what it was
// sent. Batches wait too, since their ops run through these. `fail` names a
// method (`relations.create`) whose next call is refused.
const heldClient = ({ raw, fail = null } = {}) => {
  let n = 0;
  let open;
  let gate = new Promise((resolve) => (open = resolve));
  const calls = [];
  const bundle = (name, methods) =>
    Object.fromEntries(
      Object.entries(methods).map(([method, answer]) => [
        method,
        async (...args) => {
          await gate;
          calls.push({ call: `${name}.${method}`, args });
          if (fail === `${name}.${method}`) {
            fail = null;
            throw new Error('refused');
          }
          return answer(...args);
        },
      ]),
    );
  const ids = (prefix, rows) => ({ ids: rows.map(() => `${prefix}-${n++}`) });
  const client = withOps({
    relations: bundle('relations', {
      create: () => ({ id: `rel-${n++}` }),
      delete: () => {},
      update: () => {},
      patchMetadata: () => {},
    }),
    spans: bundle('spans', {
      create: () => ({ id: `span-${n++}` }),
      bulkCreate: (rows) => ids('span', rows),
      delete: () => {},
      update: () => {},
      patchMetadata: () => {},
    }),
    tokens: bundle('tokens', {
      bulkCreate: (rows) => ids('tok', rows),
      bulkDelete: () => {},
      delete: () => {},
      split: () => ({ id: `tok-${n++}` }),
      merge: () => {},
      setMetadata: () => {},
      patchMetadata: () => {},
    }),
    texts: bundle('texts', { update: () => {} }),
    documents: { get: async () => structuredClone(raw) },
  });
  const release = () => {
    open();
    gate = Promise.resolve();
  };
  return { client, release, calls };
};

const open = (options = {}) => {
  const raw = rawDocFromConllu(INPUT, 'o', { enhanced: true });
  const { client, release, calls } = heldClient({ raw, ...options });
  const doc = new ConlluDocument({ raw: structuredClone(raw), client });
  const lemma = (value) => doc.layerInfo.lemmaLayer.spans.find((s) => s.value === value)?.id;
  const token = (form) => {
    const body = doc.layerInfo.textLayer.text.body;
    return doc.layerInfo.tokenLayer.tokens.find(
      (t) => [...body].slice(t.begin, t.end).join('') === form,
    ).id;
  };
  const headOf = (spanId) =>
    doc.layerInfo.relationLayer.relations.filter((r) => r.target === spanId);
  return { doc, release, calls, lemma, token, headOf };
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

test('a second edit made while the first is in flight shows at once and is sent after it', async () => {
  const { doc, release, calls, lemma, headOf } = open();
  const drawn = doc.createRelation(lemma('come'), lemma('home'), 'obj');
  await settle();
  const [pending] = headOf(lemma('home'));
  // Relabelled before the server has answered for the relation at all.
  const relabelled = doc.updateRelation(pending.id, 'nmod');
  await settle();
  assert.equal(headOf(lemma('home'))[0].value, 'nmod');

  release();
  assert.equal(await drawn, true);
  assert.equal(await relabelled, true);
  const [saved] = headOf(lemma('home'));
  assert.equal(saved.value, 'nmod');
  const update = calls.find((c) => c.call === 'relations.update');
  assert.equal(update.args[0], saved.id, 'the relabel was sent under the pending id');
  assert.ok(!isPendingId(saved.id));
});

test('a refused write reloads, and the edits queued behind it are not sent', async () => {
  const { doc, release, calls, lemma, headOf } = open({ fail: 'relations.create' });
  const before = headOf(lemma('home'))[0];
  const drawn = doc.createRelation(lemma('come'), lemma('home'), 'obj');
  await settle();
  const relabelled = doc.updateRelation(headOf(lemma('home'))[0].id, 'nmod');

  release();
  assert.equal(await drawn, false);
  assert.equal(await relabelled, false);
  assert.ok(!calls.some((c) => c.call === 'relations.update'));
  assert.deepEqual(headOf(lemma('home')), [before]);
  assert.equal(doc.isSaving, false);
});

test('a sentence split and a merge show before the server answers', async () => {
  const { doc, release } = open();
  const sentences = () => doc.layerInfo.sentenceTokenLayer.tokens;
  const at = [...doc.layerInfo.textLayer.text.body].indexOf('a', 8); // "and"
  const split = doc.toggleSentenceBoundary(at);
  await settle();
  assert.equal(sentences().length, 2);
  const merged = doc.toggleSentenceBoundary(at);
  await settle();
  assert.equal(sentences().length, 1);

  release();
  assert.equal(await split, true);
  assert.equal(await merged, true);
  assert.equal(sentences().length, 1);
});

test('a word made by hand shows before the server answers, and an edit of it follows', async () => {
  const { doc, release, calls } = open();
  const cleared = doc.clearTokens();
  await settle();
  assert.equal(doc.layerInfo.wordTokenLayer.tokens.length, 0);
  assert.equal(doc.layerInfo.relationLayer.relations.length, 0);

  const body = doc.layerInfo.textLayer.text.body;
  const made = doc.createWord(0, 3, body);
  await settle();
  const [morpheme] = doc.layerInfo.morphemeTokenLayer.tokens;
  assert.equal(doc.layerInfo.wordTokenLayer.tokens.length, 1);
  assert.ok(isPendingId(morpheme.id));
  const tagged = doc.updateAnnotation(morpheme.id, 'upos', 'PRON');
  await settle();
  assert.equal(
    doc.layerInfo.uposLayer.spans.find((s) => s.tokens[0] === morpheme.id).value,
    'PRON',
  );

  release();
  assert.equal(await cleared, true);
  assert.equal(await made, true);
  assert.equal(await tagged, true);
  const [savedMorpheme] = doc.layerInfo.morphemeTokenLayer.tokens;
  assert.ok(!isPendingId(savedMorpheme.id));
  const upos = calls.find((c) => c.call === 'spans.create');
  assert.deepEqual(upos.args[1], [savedMorpheme.id]);
});

test('tokenizing shows every token and lemma before the server answers', async () => {
  const { doc, release } = open();
  const cleared = doc.clearTokens();
  await settle();
  const body = doc.layerInfo.textLayer.text.body;
  const tokenized = doc.tokenize(body);
  await settle();
  const words = doc.layerInfo.wordTokenLayer.tokens;
  assert.equal(words.length, 6);
  assert.equal(doc.layerInfo.lemmaLayer.spans.length, 6);

  release();
  assert.equal(await cleared, true);
  assert.equal(await tokenized, true);
  const lemmas = doc.layerInfo.lemmaLayer.spans;
  const morphemes = new Set(doc.layerInfo.morphemeTokenLayer.tokens.map((t) => t.id));
  assert.ok(lemmas.every((s) => !isPendingId(s.id) && morphemes.has(s.tokens[0])));
});

test('splitting a word into two shows before the server answers', async () => {
  const { doc, release, token } = open();
  const word = doc.layerInfo.wordTokenLayer.tokens.find((w) => w.begin === 0);
  const morphemes = () =>
    doc.layerInfo.morphemeTokenLayer.tokens.filter((m) => m.begin === word.begin);
  const oldMorpheme = token('she');
  const write = doc.setWordMorphemes(word, ['sh', 'e']);
  await settle();
  assert.equal(morphemes().length, 2);
  assert.ok(!doc.layerInfo.lemmaLayer.spans.some((s) => s.tokens.includes(oldMorpheme)));
  assert.equal(doc.layerInfo.formLayer.spans.filter((s) => s.value === 'sh').length, 1);

  release();
  assert.equal(await write, true);
  assert.ok(morphemes().every((m) => !isPendingId(m.id)));
});
