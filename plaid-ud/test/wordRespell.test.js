// Respelling a token's words in the Text Editor (V3 S3, decision D12), and
// the lemmas a new word starts with (V3 S2, decision D13).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isMachine } from '@larc-iu/plaid-client';
import { ConlluDocument } from '../src/domain/ConlluDocument.js';
import { rawDocFromConllu } from './helpers/rawDoc.js';
import { withOps } from './helpers/stubClient.js';

const INPUT = [
  '# text = she came and left home .',
  '1\tshe\tshe\tPRON\t_\t_\t2\tnsubj\t_\t_',
  '2\tcame\tcome\tVERB\t_\t_\t0\troot\t_\t_',
  '3\tand\tand\tCCONJ\t_\t_\t4\tcc\t_\t_',
  '4\tleft\tleave\tVERB\t_\t_\t2\tconj\t_\t_',
  '5\thome\thome\tNOUN\t_\t_\t4\tobj\t_\t_',
  '6\t.\t_\t_\t_\t_\t_\t_\t_\t_',
].join('\n');

// "del" as two words, de + el, over one token.
const MWT = [
  '# text = del perro',
  '1-2\tdel\t_\t_\t_\t_\t_\t_\t_\t_',
  '1\tde\tde\tADP\t_\t_\t3\tcase\t_\t_',
  '2\tel\tel\tDET\t_\t_\t3\tdet\t_\t_',
  '3\tperro\tperro\tNOUN\t_\t_\t0\troot\t_\t_',
].join('\n');

function open(input = INPUT) {
  const raw = rawDocFromConllu(input, 'w');
  let n = 0;
  const calls = [];
  const rec =
    (call, answer = () => ({})) =>
    async (...args) => {
      calls.push({ call, args });
      return answer(...args);
    };
  const ids = (rows) => ({ ids: rows.map(() => `new-${n++}`) });
  const client = withOps({
    tokens: {
      bulkCreate: rec('tokens.bulkCreate', ids),
      bulkDelete: rec('tokens.bulkDelete'),
      patchMetadata: rec('tokens.patchMetadata'),
    },
    spans: {
      create: rec('spans.create', () => ({ id: `span-${n++}` })),
      bulkCreate: rec('spans.bulkCreate', ids),
      update: rec('spans.update'),
      delete: rec('spans.delete'),
      patchMetadata: rec('spans.patchMetadata'),
    },
    documents: { get: async () => structuredClone(raw) },
  });
  const doc = new ConlluDocument({ raw: structuredClone(raw), client });
  const body = () => doc.layerInfo.textLayer.text.body;
  const word = (surface) =>
    doc.layerInfo.wordTokenLayer.tokens.find(
      (w) => [...body()].slice(w.begin, w.end).join('') === surface,
    );
  const kinds = () => calls.map((c) => c.call);
  return { doc, calls, kinds, word };
}

test('respelling a word keeps its word and everything on it, and writes only its Form', async () => {
  const { doc, kinds, calls, word } = open();
  const home = word('home');
  const [morpheme] = doc.layerInfo.morphemeTokenLayer.tokens.filter((m) => m.begin === home.begin);
  const lemma = doc.layerInfo.lemmaLayer.spans.find((s) => s.tokens[0] === morpheme.id);
  const upos = doc.layerInfo.uposLayer.spans.find((s) => s.tokens[0] === morpheme.id);
  const heads = doc.layerInfo.relationLayer.relations.filter((r) => r.target === lemma.id);

  assert.equal(await doc.setWordMorphemes(home, ['house']), true);

  assert.ok(!kinds().includes('tokens.bulkDelete'));
  assert.ok(!kinds().includes('tokens.bulkCreate'));
  const create = calls.find((c) => c.call === 'spans.create');
  assert.deepEqual(create.args.slice(0, 3), [doc.layerInfo.formLayer.id, [morpheme.id], 'house']);
  // The word, its lemma, its UPOS and its head are all still there.
  assert.ok(doc.layerInfo.morphemeTokenLayer.tokens.some((m) => m.id === morpheme.id));
  assert.ok(doc.layerInfo.lemmaLayer.spans.some((s) => s.id === lemma.id && s.value === 'home'));
  assert.ok(doc.layerInfo.uposLayer.spans.some((s) => s.id === upos.id));
  assert.equal(heads.length, 1);
  assert.ok(doc.layerInfo.relationLayer.relations.some((r) => r.id === heads[0].id));
  assert.ok(
    doc.layerInfo.formLayer.spans.some((s) => s.tokens[0] === morpheme.id && s.value === 'house'),
  );
});

test('respelling the words of a multi-word token updates their Forms in place', async () => {
  const { doc, calls, kinds, word } = open(MWT);
  const del = word('del');
  assert.equal(await doc.setWordMorphemes(del, ['de', 'le']), true);
  assert.ok(!kinds().includes('tokens.bulkDelete'));
  const updates = calls.filter((c) => c.call === 'spans.update').map((c) => c.args[1]);
  assert.deepEqual(updates, ['le']);
  const forms = doc.layerInfo.formLayer.spans.map((s) => s.value).sort();
  assert.deepEqual(forms, ['de', 'le']);
});

test('respelling a word back to its own text removes its Form', async () => {
  const { doc, calls, word } = open();
  const home = word('home');
  await doc.setWordMorphemes(home, ['house']);
  calls.length = 0;
  assert.equal(await doc.setWordMorphemes(home, ['home']), true);
  assert.deepEqual(
    calls.map((c) => c.call),
    ['spans.delete'],
  );
});

test('a respelling that changes nothing sends nothing', async () => {
  const { doc, calls, word } = open();
  assert.equal(await doc.setWordMorphemes(word('home'), ['home']), true);
  assert.deepEqual(calls, []);
});

test('changing how many words a token has still replaces them', async () => {
  const { doc, kinds, word } = open();
  assert.equal(await doc.setWordMorphemes(word('home'), ['ho', 'me']), true);
  assert.ok(kinds().includes('tokens.bulkDelete'));
  assert.ok(kinds().includes('tokens.bulkCreate'));
});

test("what replacing a token's words deletes: annotations but not a lemma that repeats the form, and relations", () => {
  const { doc, word } = open();
  // she: lemma "she" repeats the form, UPOS PRON, head nsubj.
  assert.deepEqual(doc.annotationLossForWord(word('she')), {
    annotations: 1,
    relations: 1,
    forms: 0,
  });
  // left: lemma "leave", UPOS VERB, its head conj and two dependents.
  assert.deepEqual(doc.annotationLossForWord(word('left')), {
    annotations: 2,
    relations: 3,
    forms: 0,
  });
  // ".": nothing on it.
  assert.deepEqual(doc.annotationLossForWord(word('.')), {
    annotations: 0,
    relations: 0,
    forms: 0,
  });
});

test("a token's forms: every one on a multiword token, and a respelled one", async () => {
  // del = de + el with nothing else on the words: the split is all there is.
  const bare = open(
    [
      '# text = del perro',
      '1-2\tdel\t_\t_\t_\t_\t_\t_\t_\t_',
      '1\tde\t_\t_\t_\t_\t_\t_\t_\t_',
      '2\tel\t_\t_\t_\t_\t_\t_\t_\t_',
      '3\tperro\t_\t_\t_\t_\t_\t_\t_\t_',
    ].join('\n'),
  );
  assert.deepEqual(bare.doc.annotationLossForWord(bare.word('del')), {
    annotations: 0,
    relations: 0,
    forms: 2,
  });
  assert.equal(bare.doc.annotationLossForWord(bare.word('perro')).forms, 0);
  const { doc, word } = open();
  await doc.setWordMorphemes(word('home'), ['house']);
  assert.equal(doc.annotationLossForWord(word('home')).forms, 1);
});

test('the lemmas Tokenize, a new word and a new set of words start with are stamped machine', async () => {
  const { doc, calls, word } = open();
  const body = doc.layerInfo.textLayer.text.body;
  await doc.setWordMorphemes(word('home'), ['ho', 'me']);
  await doc.clearTokens();
  await doc.tokenize(body);
  const lemmaRows = calls
    .filter((c) => c.call === 'spans.bulkCreate')
    .flatMap((c) => c.args[0])
    .filter((row) => row.spanLayerId === doc.layerInfo.lemmaLayer.id);
  assert.ok(lemmaRows.length >= 8);
  assert.ok(lemmaRows.every((row) => isMachine(row.metadata)));
  assert.ok(doc.layerInfo.lemmaLayer.spans.every((s) => isMachine(s.metadata)));
});
