// H33-UD-1: a word another app made has no UD word until a writer opens the
// document and the repair on open seeds one. The export and a reader's grid
// never seed, and they left such words out: a fully bare document exported as
// "No tokens." and a partly bare one lost the word from its rows while `# text`
// kept it. Every row now stands in for the seed, and nothing is written.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConlluDocument } from '../src/domain/ConlluDocument.js';
import { NOT_TOKENIZED_FILE } from '../src/domain/conlluSerialize.js';
import { isVirtualWordId } from '../src/domain/sentenceRows.js';
import { graphFromSentence } from '../src/grew/rewrite/graph.js';
import { rawDocFromConllu } from './helpers/rawDoc.js';

const INPUT = [
  '# text = the dog barks',
  '1\tthe\tthe\tDET\t_\t_\t2\tdet\t_\t_',
  '2\tdog\tdog\tNOUN\t_\tNumber=Sing\t3\tnsubj\t_\t_',
  '3\tbarks\tbark\tVERB\t_\t_\t0\troot\t_\t_',
].join('\n');

// The document with the UD words whose text is in `forms` taken away, with
// every span on them and every relation touching their lemma spans, as a word
// made by another app after the last UD open stands.
const bare = (forms) => {
  const raw = rawDocFromConllu(INPUT, 'd1');
  const textLayer = raw.textLayers[0];
  const body = [...textLayer.text.body];
  const words = textLayer.tokenLayers.find((l) => l.config?.plaid?.role === 'syntactic-word');
  const gone = new Set(
    words.tokens
      .filter((t) => forms.includes(body.slice(t.begin, t.end).join('')))
      .map((t) => t.id),
  );
  words.tokens = words.tokens.filter((t) => !gone.has(t.id));
  const goneSpans = new Set();
  for (const layer of words.spanLayers) {
    for (const span of layer.spans || []) {
      if (span.tokens.some((t) => gone.has(t))) goneSpans.add(span.id);
    }
    layer.spans = (layer.spans || []).filter((s) => !goneSpans.has(s.id));
  }
  for (const layer of words.spanLayers) {
    for (const rel of layer.relationLayers || []) {
      rel.relations = (rel.relations || []).filter(
        (r) => !goneSpans.has(r.source) && !goneSpans.has(r.target),
      );
    }
  }
  return raw;
};

const rowsOf = (conllu) => conllu.split('\n').filter((l) => /^\d/.test(l));

test('a document whose words all lack a UD word exports every word', () => {
  const doc = new ConlluDocument({ raw: bare(['the', 'dog', 'barks']) });
  assert.equal(doc.layerInfo.morphemeTokenLayer.tokens.length, 0);
  const out = doc.toConllu();
  assert.notEqual(out, NOT_TOKENIZED_FILE);
  assert.deepEqual(rowsOf(out), [
    '1\tthe\t_\t_\t_\t_\t_\t_\t_\t_',
    '2\tdog\t_\t_\t_\t_\t_\t_\t_\t_',
    '3\tbarks\t_\t_\t_\t_\t_\t_\t_\t_',
  ]);
  assert.ok(out.includes('# text = the dog barks'));
});

test('a word with no UD word keeps its row among annotated ones', () => {
  const doc = new ConlluDocument({ raw: bare(['dog']) });
  const rows = rowsOf(doc.toConllu());
  assert.deepEqual(
    rows.map((r) => r.split('\t').slice(0, 4)),
    [
      ['1', 'the', 'the', 'DET'],
      ['2', 'dog', '_', '_'],
      ['3', 'barks', 'bark', 'VERB'],
    ],
  );
  // The relation into `dog` went with it, and the root stays.
  assert.equal(rows[2].split('\t')[6], '0');
});

test("a reader's rows show the word as the seed would make it, and write nothing", () => {
  const doc = new ConlluDocument({ raw: bare(['dog']) });
  const entry = doc.sentences[0].tokens[1];
  assert.equal(entry.virtual, true);
  assert.ok(isVirtualWordId(entry.token.id));
  assert.equal(entry.tokenForm, 'dog');
  assert.equal(entry.word.id, doc.layerInfo.wordTokenLayer.tokens[1].id);
  assert.deepEqual([entry.lemma, entry.upos, entry.feats], [null, null, []]);
  // The rewrite's graph has no node for it, as the server's search has none.
  const graph = graphFromSentence(doc.sentences[0]);
  assert.deepEqual(
    [...graph.nodes.values()].filter((n) => !n.anchor).map((n) => n.form),
    ['the', 'barks'],
  );
});

test("a writer's edit of such a word is refused before any request", async () => {
  const calls = [];
  const client = new Proxy(
    {},
    {
      get: (_t, key) => {
        calls.push(String(key));
        return () => Promise.resolve({});
      },
    },
  );
  const errors = [];
  const doc = new ConlluDocument({
    raw: bare(['dog']),
    client,
    project: { id: 'p1', maintainers: ['m@x'], writers: [] },
    user: { id: 'm@x' },
  });
  doc.onError = (message) => errors.push(message);
  const virtual = doc.sentences[0].tokens[1].token.id;
  const barks = doc.sentences[0].tokens[2].token.id;
  assert.equal(await doc.updateAnnotation(virtual, 'upos', 'NOUN'), false);
  assert.equal(await doc.createRelation(barks, virtual, 'nsubj'), false);
  assert.equal(await doc.createEnhancedRelation(barks, virtual, 'nsubj'), false);
  // Every UD write is refused at one door (REV-FX3-UD R3), the ones that take
  // a word or a list of ids included.
  assert.equal(await doc.deleteWord(virtual), false);
  assert.equal(await doc.setWordMorphemes({ id: virtual }, ['do', 'g']), false);
  assert.equal(await doc.deleteFeature(virtual), false);
  assert.deepEqual(calls, []);
  assert.equal(errors.length, 6);
  assert.ok(errors.every((m) => m.endsWith('Reopen the document to annotate this word.')));
});

test('Accept and Discard leave a stand-in out rather than refusing', async () => {
  const calls = [];
  const client = new Proxy(
    {},
    {
      get: (_t, key) => {
        calls.push(String(key));
        return () => Promise.resolve({});
      },
    },
  );
  const errors = [];
  const doc = new ConlluDocument({
    raw: bare(['dog']),
    client,
    project: { id: 'p1', maintainers: ['m@x'], writers: [] },
    user: { id: 'm@x' },
  });
  doc.onError = (message) => errors.push(message);
  const virtual = doc.sentences[0].tokens[1].token.id;
  // Only the stand-in: nothing left to accept, nothing sent, nothing said.
  assert.equal(await doc.confirmTokens([virtual]), false);
  assert.equal(await doc.discardTokens([virtual]), false);
  assert.deepEqual(calls, []);
  assert.deepEqual(errors, []);
});
