// A word another app made has no UD word under it until the first write on it
// makes one (R3, 2026-10-24). Every reader shows it as the one 1:1 UD word that
// write makes (H33-UD-1: the export once left such words out), and opening the
// document writes nothing.
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

test("a reader's rows show the word as its first write makes it, and write nothing", () => {
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

// A client recording each request: a batch as the list of its ops, each with
// the arguments it was queued with, and a call made on the client itself as
// one op. Every write answers at once.
const recording = () => {
  const sent = [];
  const answer = () => Promise.resolve({});
  const bundle = (name, queue) =>
    new Proxy(
      {},
      {
        get:
          (_t, method) =>
          (...args) => {
            const op = { op: `${name}.${String(method)}`, args };
            if (queue) queue.push(op);
            else sent.push([op]);
            return queue ? { batched: true } : answer();
          },
      },
    );
  const resources = ['tokens', 'spans', 'relations', 'documents', 'texts', 'tokenLayers'];
  const view = (queue) => Object.fromEntries(resources.map((r) => [r, bundle(r, queue)]));
  const client = {
    ...view(null),
    withOperation: async (_label, fn) => fn(() => {}),
    keySeed: () => null,
    batched: async (fn) => {
      const ops = [];
      await fn(view(ops));
      sent.push(ops);
      return ops.map(() => ({}));
    },
  };
  return { client, sent };
};

const writer = (raw, client) => {
  const errors = [];
  const doc = new ConlluDocument({
    raw,
    client,
    project: { id: 'p1', maintainers: ['m@x'], writers: [] },
    user: { id: 'm@x' },
  });
  doc.onError = (message) => errors.push(message);
  return { doc, errors };
};

const settleQueue = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};

test("a writer's open of a document whose words lack a UD word writes nothing", async () => {
  const { client, sent } = recording();
  const { doc } = writer(bare(['the', 'dog', 'barks']), client);
  const result = await doc.validateOnOpen();
  assert.deepEqual(result.findings, []);
  assert.deepEqual(sent, []);
  // Each word still has its row, under its stand-in.
  assert.equal(doc.sentences[0].tokens.length, 3);
});

test('a value on such a word makes the word, its lemma from its form, and the value in one batch', async () => {
  const { client, sent } = recording();
  const { doc, errors } = writer(bare(['dog']), client);
  const virtual = doc.sentences[0].tokens[1].token.id;
  const word = doc.layerInfo.wordTokenLayer.tokens[1];
  const ok = doc.updateAnnotation(virtual, 'upos', 'NOUN');
  // Shown before the server answers, in the row the stand-in had.
  const entry = doc.sentences[0].tokens[1];
  assert.equal(entry.virtual, undefined);
  assert.equal(entry.upos?.value, 'NOUN');
  assert.equal(entry.lemma?.value, 'dog');
  assert.equal(await ok, true);
  assert.deepEqual(errors, []);
  assert.equal(sent.length, 1);
  const [batch] = sent;
  assert.deepEqual(
    batch.map((o) => o.op),
    ['tokens.bulkCreate', 'spans.bulkCreate', 'spans.create'],
  );
  const [made] = batch[0].args[0];
  assert.equal(made.tokenLayerId, doc.layerInfo.morphemeTokenLayer.id);
  assert.deepEqual([made.begin, made.end, made.precedence], [word.begin, word.end, 0]);
  const [lemma] = batch[1].args[0];
  assert.deepEqual(
    [lemma.spanLayerId, lemma.tokens, lemma.value, lemma.metadata?.provSource],
    [doc.layerInfo.lemmaLayer.id, [made.id], 'dog', 'rule:lemma-from-form'],
  );
  assert.deepEqual(batch[2].args.slice(0, 3), [doc.layerInfo.uposLayer.id, [made.id], 'NOUN']);
});

test('a lemma typed on such a word is the lemma the word is made with, as the person typed it', async () => {
  const { client, sent } = recording();
  const { doc } = writer(bare(['dog']), client);
  const virtual = doc.sentences[0].tokens[1].token.id;
  assert.equal(await doc.updateAnnotation(virtual, 'lemma', 'hound'), true);
  assert.equal(sent.length, 1);
  // The word and its lemma, holding the typed value with the writer's stamp
  // (a verifier's: none), not the rule's copy of the form verified.
  assert.deepEqual(
    sent[0].map((o) => o.op),
    ['tokens.bulkCreate', 'spans.bulkCreate'],
  );
  const lemma = sent[0][1].args[0][0];
  assert.deepEqual([lemma.value, lemma.metadata], ['hound', undefined]);
  assert.equal(doc.sentences[0].tokens[1].lemma.value, 'hound');
  assert.equal(doc.sentences[0].tokens[1].lemma.metadata, undefined);
});

test("a contributor's lemma typed on such a word is marked contributed", async () => {
  const { client, sent } = recording();
  const doc = new ConlluDocument({
    raw: bare(['dog']),
    client,
    project: { id: 'p1', writers: ['ann@x'], config: { plaid: { review: { users: ['ann@x'] } } } },
    user: { id: 'ann@x' },
  });
  const virtual = doc.sentences[0].tokens[1].token.id;
  assert.equal(await doc.updateAnnotation(virtual, 'lemma', 'hound'), true);
  const lemma = sent[0][1].args[0][0];
  assert.deepEqual(
    [lemma.value, lemma.metadata],
    ['hound', { prov: 'contributed', provSource: 'user:ann@x' }],
  );
});

test('an arc drawn to such a word makes it in the same batch, and a second edit names the word made', async () => {
  const { client, sent } = recording();
  const { doc } = writer(bare(['dog']), client);
  const virtual = doc.sentences[0].tokens[1].token.id;
  const barks = doc.sentences[0].tokens[2].token.id;
  assert.equal(await doc.createRelation(barks, virtual, 'nsubj'), true);
  assert.equal(sent.length, 1);
  const ops = sent[0].map((o) => o.op);
  assert.deepEqual(ops.slice(0, 2), ['tokens.bulkCreate', 'spans.bulkCreate']);
  assert.equal(ops.at(-1), 'relations.create');
  const made = sent[0][0].args[0][0].id;
  const lemma = sent[0][1].args[0][0].id;
  // The relation hangs off the lemma made with the word.
  assert.equal(sent[0].at(-1).args[2], lemma);
  // The screen may still hold the stand-in's id: it names the word made.
  assert.equal(await doc.updateAnnotation(virtual, 'upos', 'NOUN'), true);
  await settleQueue();
  assert.equal(sent.length, 2);
  assert.deepEqual(
    sent[1].map((o) => o.op),
    ['spans.create'],
  );
  assert.deepEqual(sent[1][0].args[1], [made]);
});

test('a write on such a word that writes nothing leaves the stand-in and sends nothing', async () => {
  const { client, sent } = recording();
  const { doc } = writer(bare(['dog']), client);
  const virtual = doc.sentences[0].tokens[1].token.id;
  // Clearing a value it does not hold.
  assert.equal(await doc.updateAnnotation(virtual, 'upos', ''), true);
  assert.deepEqual(sent, []);
  assert.equal(doc.sentences[0].tokens[1].virtual, true);
  assert.equal(doc.layerInfo.morphemeTokenLayer.tokens.length, 2);
});

test('a write that takes a token is refused when given a stand-in word', async () => {
  const { client, sent } = recording();
  const { doc, errors } = writer(bare(['dog']), client);
  const virtual = doc.sentences[0].tokens[1].token.id;
  assert.equal(await doc.deleteWord(virtual), false);
  assert.equal(await doc.setWordMorphemes({ id: virtual }, ['do', 'g']), false);
  assert.equal(await doc.deleteFeature(virtual), false);
  assert.deepEqual(sent, []);
  assert.equal(errors.length, 3);
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

// REV-W2B-OPENS L1: a stand-in id held past a reload that brought in another
// tab's word for the same token names that word, and makes no second one.
test("a stand-in held past a reload that brought another tab's word names that word", async () => {
  const { client, sent } = recording();
  const { doc, errors } = writer(bare(['dog']), client);
  const virtual = doc.sentences[0].tokens[1].token.id;
  const full = rawDocFromConllu(INPUT, 'd1');
  const words = full.textLayers[0].tokenLayers.find(
    (l) => l.config?.plaid?.role === 'syntactic-word',
  );
  const theirs = words.tokens[1].id;
  doc._swapRaw(full);
  assert.equal(await doc.updateAnnotation(virtual, 'xpos', 'NN'), true);
  assert.deepEqual(errors, []);
  assert.equal(sent.length, 1);
  assert.deepEqual(
    sent[0].map((o) => o.op),
    ['spans.create'],
  );
  assert.deepEqual(sent[0][0].args[1], [theirs]);
  assert.equal(doc.layerInfo.morphemeTokenLayer.tokens.length, 3);
});

test('a stand-in held past a reload that split its token into several words is refused', async () => {
  const { client, sent } = recording();
  const { doc, errors } = writer(bare(['dog']), client);
  const virtual = doc.sentences[0].tokens[1].token.id;
  const split = structuredClone(doc._raw);
  const word = doc.layerInfo.wordTokenLayer.tokens[1];
  const layer = split.textLayers[0].tokenLayers.find(
    (l) => l.config?.plaid?.role === 'syntactic-word',
  );
  layer.tokens.push(
    { id: 'theirs-a', begin: word.begin, end: word.begin + 1, precedence: 0 },
    { id: 'theirs-b', begin: word.begin + 1, end: word.end, precedence: 0 },
  );
  doc._swapRaw(split);
  assert.equal(await doc.updateAnnotation(virtual, 'xpos', 'NN'), false);
  assert.deepEqual(sent, []);
  assert.equal(errors.length, 1);
  assert.equal(layer.tokens.length, doc.layerInfo.morphemeTokenLayer.tokens.length);
});

// REV-W2B-OPENS L2: a stand-in holds no lemma, so clearing it writes nothing,
// as the assistant's plan does (plaid-agent ud/plan.py `_apply_set_span`).
test('clearing the lemma of a stand-in writes nothing and leaves the stand-in', async () => {
  const { client, sent } = recording();
  const { doc } = writer(bare(['dog']), client);
  const virtual = doc.sentences[0].tokens[1].token.id;
  assert.equal(await doc.updateAnnotation(virtual, 'lemma', ''), true);
  assert.equal(await doc.updateAnnotation(virtual, 'lemma', null), true);
  await settleQueue();
  assert.deepEqual(sent, []);
  assert.equal(doc.sentences[0].tokens[1].virtual, true);
  assert.equal(doc.layerInfo.morphemeTokenLayer.tokens.length, 2);
});

// A lemma made only to hang an arc on is the rule's, as every lemma a new word
// starts with: its Form (else its text), stamped machine-made, so a parser may
// replace it and Discard predictions does not keep it as a person's.
test('an arc to a stored word with no lemma makes its lemma by the rule, from its Form', async () => {
  const raw = rawDocFromConllu(INPUT, 'd1');
  const words = raw.textLayers[0].tokenLayers.find(
    (l) => l.config?.plaid?.role === 'syntactic-word',
  );
  const probe = new ConlluDocument({ raw: rawDocFromConllu(INPUT, 'd1') });
  const { lemmaLayer, formLayer } = probe.layerInfo;
  const body = [...raw.textLayers[0].text.body];
  const dog = words.tokens.find((t) => body.slice(t.begin, t.end).join('') === 'dog');
  for (const layer of words.spanLayers) {
    if (layer.id === lemmaLayer.id) {
      const gone = layer.spans.find((s) => s.tokens.includes(dog.id)).id;
      layer.spans = layer.spans.filter((s) => s.id !== gone);
      for (const rel of layer.relationLayers || [])
        rel.relations = rel.relations.filter((r) => r.source !== gone && r.target !== gone);
    }
    if (layer.id === formLayer.id) {
      layer.spans = [...(layer.spans || []), { id: 'f-dog', tokens: [dog.id], value: 'dogs' }];
    }
  }
  const { client, sent } = recording();
  const { doc } = writer(raw, client);
  const barks = doc.sentences[0].tokens[2].token.id;
  assert.equal(await doc.createRelation(barks, dog.id, 'nsubj'), true);
  const made = sent[0].find((o) => o.op === 'spans.create' && o.args[0] === lemmaLayer.id);
  assert.equal(made.args[2], 'dogs');
  assert.deepEqual(
    [made.args[3].prov, made.args[3].provSource, made.args[3].provDetail.model],
    ['inferred', 'rule:lemma-from-form', 'builtin:lemma-from-form'],
  );
});
