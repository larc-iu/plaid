// What reconcile on open puts right beyond the unaligned nodes' anchors
// (the owner's rulings of 2026-09-28), on a document as the storage model
// holds it: a node whose word IGT deleted, an add cut off after its first
// request, and variables whose sentence number moved. Each is one audited
// repair, unstamped, and a second pass finds nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyMetadataOps } from '@larc-iu/plaid-client';
import { parseUmrFile } from '../src/domain/format/umrFile.js';
import { planImport } from '../src/domain/umrImport.js';
import { UmrDocument } from '../src/domain/UmrDocument.js';
import { planRenumber } from '../src/domain/umrReconcile.js';
import { rawFromPlan } from './rawFromPlan.js';
import { recordingClient } from './recordingClient.js';

const SEP = '#'.repeat(80);
const TEXT = `${SEP}
# :: snt1
Index: 1 2 3
Words: Ali geldi .

# sentence level graph:
(s1g / gel-01
    :ARG1 (s1a / person))

# alignment:
s1g: 2-2
s1a: 1-1

# document level annotation:
(s1s0 / sentence
    :modal ((root :modal author)
        (author :full-affirmative s1g)))

${SEP}
# :: snt2
Index: 1 2 3 4 5
Words: Evimizde misafirler yemek yediler .

# sentence level graph:
(s2y / ye-01
    :ARG0 (s2m / misafir)
    :ARG1 (s2y2 / yemek)
    :place (s2e / ev))

# alignment:
s2y: 4-4
s2m: 2-2
s2y2: 3-3
s2e: 1-1

# document level annotation:
(s2s0 / sentence
    :temporal ((s1g :before s2y)))
`;

const layers = (raw) => {
  const text = raw.textLayers[0];
  const nodes = text.tokenLayers.find((l) => l.config?.umr?.nodes);
  return {
    text,
    sentences: text.tokenLayers.find((l) => l.config?.plaid?.role === 'sentence'),
    words: text.tokenLayers.find((l) => l.config?.plaid?.role === 'word'),
    nodes,
    spans: nodes.spanLayers[0].spans,
  };
};

function load(edit = null) {
  const raw = rawFromPlan(planImport(parseUmrFile(TEXT).sentences, []));
  if (edit) edit(raw, layers(raw));
  const { client, calls } = recordingClient();
  const doc = new UmrDocument({ raw, client });
  doc._reload = async () => {};
  return { doc, calls, raw };
}

// A document annotated in Plaid stores no sentence numbers. An imported one
// whose first sentence IGT deleted stores numbers that start at 2, and is not
// renumbered (reconcileNarrowings.test.js).
const madeInPlaid = (L) =>
  L.sentences.tokens.forEach((t) => {
    delete t.metadata.umr.snt;
  });

const byVar = (doc, v) => [...doc.graph.nodesById.values()].find((n) => n.var === v);

// What the server holds after the pass, from the calls: enough of it to
// read the document again and check a second pass has nothing to do.
function replay(raw, calls) {
  const next = structuredClone(raw);
  const L = layers(next);
  calls.forEach(({ name, args }) => {
    if (name === 'tokens.bulkDelete') {
      const gone = new Set(args[0]);
      L.nodes.tokens = L.nodes.tokens.filter((t) => !gone.has(t.id));
      L.nodes.spanLayers[0].spans = L.nodes.spanLayers[0].spans.filter((s) =>
        s.tokens.some((t) => !gone.has(t)),
      );
      L.nodes.spanLayers[0].spans.forEach((s) => {
        s.tokens = s.tokens.filter((t) => !gone.has(t));
      });
    } else if (name === 'tokens.update') {
      const t = L.nodes.tokens.find((x) => x.id === args[0]);
      t.begin = args[1];
      t.end = args[2];
    } else if (name === 'spans.patchMetadata') {
      const s = L.nodes.spanLayers[0].spans.find((x) => x.id === args[0]);
      s.metadata = applyMetadataOps(s.metadata, args[1]);
    } else if (name === 'spans.setTokens') {
      L.nodes.spanLayers[0].spans.find((x) => x.id === args[0]).tokens = args[1];
    }
  });
  return next;
}

async function twice(loaded) {
  const { doc, calls, raw } = loaded;
  const result = await doc._reconcile();
  const label = doc.describeReconcile(result);
  const { client, calls: again } = recordingClient();
  const after = new UmrDocument({ raw: replay(raw, calls), client });
  after._reload = async () => {};
  assert.deepEqual(await after._reconcile(), { findings: [] }, 'a second pass finds nothing');
  assert.equal(again.length, 0);
  return { result, label, after };
}

// The client's tokens.update is not in the recording client: record it.
const withUpdate = (loaded) => {
  loaded.doc._client.tokens.update = async (...args) =>
    loaded.calls.push({ name: 'tokens.update', args });
  return loaded;
};

test('a node whose word was deleted becomes an ordinary unaligned node, named in History', async () => {
  const loaded = withUpdate(
    load((raw, L) => {
      // IGT deletes the word token "yemek": the text stays.
      const at = raw.textLayers[0].text.body.indexOf('yemek');
      L.words.tokens = L.words.tokens.filter((t) => t.begin !== at);
    }),
  );
  const { doc, calls } = loaded;
  const node = byVar(doc, 's2y2');
  // Read as unaligned already, so the canvas and the export agree before the
  // repair (and in a past state, which does not repair).
  assert.equal(node.aligned, false);
  assert.deepEqual(node.alignment, []);
  const sentence = doc.sentence(2);
  const { result, label, after } = await twice(loaded);
  assert.deepEqual(result.unanchored, ['s2y2']);
  assert.equal(label, 'Repaired: 1 node lost its word (s2y2)');
  assert.deepEqual(
    calls.filter((c) => c.name === 'spans.patchMetadata').map((c) => c.args),
    [[node.id, [{ op: 'set', path: ['umr', 'sentence'], value: sentence.tokenId }]]],
  );
  // Its anchor stays over the word's text: stretched over the sentence, a
  // split of the sentence before that text would leave it on the left and
  // core would delete its relations to the right half.
  assert.deepEqual(
    calls.filter((c) => c.name === 'tokens.update').map((c) => c.args),
    [],
  );
  // Now it records its sentence, so a word typed back under it does not
  // align it again.
  const healed = byVar(after, 's2y2');
  assert.equal(healed.aligned, false);
  assert.equal(healed.sentence, 2);
  const at = after.graph.sentences[1].text.indexOf('yemek') + sentence.begin;
  assert.deepEqual(
    healed.pieces.map((p) => [p.begin, p.end]),
    [[at, at + 'yemek'.length]],
  );
});

test('a node-layer token with no node on it, left by an add cut off, is removed', async () => {
  const loaded = load((raw, L) => {
    L.nodes.tokens.push({ id: 'stray', begin: 0, end: 10 });
  });
  const { result, label } = await twice(loaded);
  assert.equal(result.strays, 1);
  assert.equal(label, 'Repaired: removed 1 empty node an interrupted add left');
  assert.deepEqual(
    loaded.calls.filter((c) => c.name === 'tokens.bulkDelete').map((c) => c.args[0]),
    [['stray']],
  );
  // Nothing is stamped or patched.
  assert.equal(loaded.calls.filter((c) => c.name.endsWith('patchMetadata')).length, 0);
});

test('variables renumbered when a sentence before them went, as one repair', async () => {
  const loaded = load((raw, L) => {
    madeInPlaid(L);
    // IGT deleted the first sentence: its token, its words and, by the
    // cascade, the nodes over them. What was sentence 2 is sentence 1.
    const first = L.sentences.tokens[0];
    L.sentences.tokens = L.sentences.tokens.slice(1);
    L.words.tokens = L.words.tokens.filter((t) => t.begin >= first.end);
    const gone = new Set(L.nodes.tokens.filter((t) => t.end <= first.end).map((t) => t.id));
    L.nodes.tokens = L.nodes.tokens.filter((t) => !gone.has(t.id));
    const concepts = L.nodes.spanLayers[0];
    const dead = new Set(
      concepts.spans.filter((s) => s.tokens.every((t) => gone.has(t))).map((s) => s.id),
    );
    concepts.spans = concepts.spans.filter((s) => !dead.has(s.id));
    concepts.relationLayers.forEach((rl) => {
      rl.relations = rl.relations.filter((r) => !dead.has(r.source) && !dead.has(r.target));
    });
  });
  const { doc } = loaded;
  assert.deepEqual(
    doc
      .sentence(1)
      .nodes.map((n) => n.var)
      .sort(),
    ['s2e', 's2m', 's2y', 's2y2'],
  );
  const { result, label, after } = await twice(loaded);
  assert.equal(result.renumbered, 4);
  assert.equal(label, 'Repaired: renumbered 4 variables to match the sentences');
  assert.deepEqual(
    after
      .sentence(1)
      .nodes.map((n) => n.var)
      .sort(),
    ['s1e', 's1m', 's1y', 's1y2'],
  );
  // A new node takes the next free name beside them.
  assert.equal(after.variableProblem(byVar(after, 's1e').id, 's1e2'), null);
});

test('a renumbered name already taken takes a counter, and constants are left alone', () => {
  const node = (id, v, sentence, constant = false) => [id, { id, var: v, sentence, constant }];
  const graph = {
    nodesById: new Map([
      node('a', 's2x', 1),
      node('b', 's1x', 1),
      node('c', 's3y2', 2),
      node('d', 'author', null, true),
      node('e', 'x1', 1),
      node('f', 's2x2', 1),
    ]),
  };
  assert.deepEqual(planRenumber(graph), [
    { nodeId: 'a', from: 's2x', to: 's1x2' },
    { nodeId: 'f', from: 's2x2', to: 's1x3' },
    { nodeId: 'c', from: 's3y2', to: 's2y2' },
  ]);
});

test('an add that failed leaves no anchor to take back, in one request of its own operation', async () => {
  const { doc, calls } = load();
  doc.onError = () => {};
  const batched = doc._client.batched;
  let sent = null;
  // The batch reaches the server and is refused whole, as a batch is.
  doc._client.batched = async (fn) => {
    const queued = [];
    await fn(
      new Proxy(
        {},
        {
          get: (_, group) =>
            group === 'ref'
              ? () => ({ $ref: queued.length - 1 })
              : new Proxy({}, { get: (_, method) => () => queued.push(`${group}.${method}`) }),
        },
      ),
    );
    sent = queued;
    throw new Error('Network error');
  };
  const parent = byVar(doc, 's2y');
  const done = await doc.createNode({
    sentenceIndex: 2,
    concept: 'person',
    parentId: parent.id,
    role: ':ARG2',
  });
  await doc._writes?.drained?.();
  doc._client.batched = batched;
  assert.equal(done, false);
  assert.deepEqual(sent, ['tokens.bulkCreate', 'spans.create', 'relations.create']);
  assert.equal(calls.filter((c) => c.name === 'tokens.bulkDelete').length, 0);
  const ops = calls.filter((c) => c.name === 'operation').map((c) => c.args[0]);
  assert.deepEqual(ops, ['Add :ARG2 person under ye-01']);
});

test('a node that lost its word in a sentence that moved is named by its new variable', async () => {
  const loaded = withUpdate(
    load((raw, L) => {
      madeInPlaid(L);
      // Sentence 1 goes (as in the renumber test) and "yemek" loses its word.
      const first = L.sentences.tokens[0];
      L.sentences.tokens = L.sentences.tokens.slice(1);
      const at = raw.textLayers[0].text.body.indexOf('yemek');
      L.words.tokens = L.words.tokens.filter((t) => t.begin >= first.end && t.begin !== at);
      const gone = new Set(L.nodes.tokens.filter((t) => t.end <= first.end).map((t) => t.id));
      L.nodes.tokens = L.nodes.tokens.filter((t) => !gone.has(t.id));
      const concepts = L.nodes.spanLayers[0];
      const dead = new Set(
        concepts.spans.filter((s) => s.tokens.every((t) => gone.has(t))).map((s) => s.id),
      );
      concepts.spans = concepts.spans.filter((s) => !dead.has(s.id));
      concepts.relationLayers.forEach((rl) => {
        rl.relations = rl.relations.filter((r) => !dead.has(r.source) && !dead.has(r.target));
      });
    }),
  );
  const { label } = await twice(loaded);
  assert.equal(
    label,
    'Repaired: 1 node lost its word (s1y2), renumbered 4 variables to match the sentences',
  );
});
