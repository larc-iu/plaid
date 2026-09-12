// `importFromConllu` against the mirror of it that the other tests use.
//
// test/helpers/rawDoc.js reproduces the importer's writes step for step so the
// domain layer can be driven offline. Nothing held the two together, so the
// round-trip test was checking a COPY of the rule it cares about: when the
// importer dropped every dependency relation in an unlemmatized treebank, the
// mirror dropped them too and the round trip stayed green.
//
// This drives the real importer against a recording client and compares what
// it writes, op for op, with what the mirror builds.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ConlluDocument } from '../src/domain/ConlluDocument.js';
import { rawDocFromConllu } from './helpers/rawDoc.js';
import { getUdLayerInfo } from '../src/utils/udLayerUtils.js';

const conllu = (lines) => lines.join('\n');

/** A client that records the bulk creates and hands back ids for them. */
function recordingClient() {
  let n = 0;
  const open = [];
  const calls = { tokens: [], spans: [], relations: [] };
  let inBatch = false;
  const queue = (kind, ops) => {
    open.push({ kind, ops });
    calls[kind].push(ops);
  };
  return {
    calls,
    documents: {
      create: async () => ({ id: 'doc-1' }),
      get: async () => {
        throw new Error('the layer info is precomputed, so this must not be called');
      },
      delete: async () => {},
    },
    texts: { create: async () => ({ id: 'text-1' }) },
    tokens: { bulkCreate: (ops) => queue('tokens', ops) },
    spans: { bulkCreate: (ops) => queue('spans', ops) },
    relations: { bulkCreate: (ops) => queue('relations', ops) },
    isBatchMode: () => inBatch,
    abortBatch: () => {
      inBatch = false;
      open.length = 0;
    },
    batched: async (fn) => {
      inBatch = true;
      open.length = 0;
      await fn();
      inBatch = false;
      const results = open.map(({ kind, ops }) => ({
        body: { ids: ops.map(() => `${kind}-${n++}`) },
      }));
      open.length = 0;
      return results;
    },
  };
}

/** The span layers in the order the importer creates them. */
const SPAN_LAYERS = ['formLayer', 'lemmaLayer', 'uposLayer', 'xposLayer', 'featuresLayer'];

async function imported(input) {
  const mirror = rawDocFromConllu(input, 'm');
  const info = getUdLayerInfo(mirror);
  const client = recordingClient();
  const out = await ConlluDocument.importFromConllu(client, 'p1', 'm', input, info);
  assert.equal(out.documentId, 'doc-1');
  return { mirror, info, client };
}

const CASES = {
  'a lemmatized treebank with an MWT': conllu([
    '# text = del perro',
    '1-2\tdel\t_\t_\t_\t_\t_\t_\t_\t_',
    '1\tde\tde\tADP\t_\t_\t3\tcase\t_\t_',
    '2\tel\tel\tDET\t_\tDefinite=Def|PronType=Art\t3\tdet\t_\t_',
    '3\tperro\tperro\tNOUN\tNN\tGender=Masc|Number=Sing\t0\troot\t_\t_',
  ]),
  'an UNLEMMATIZED treebank, where every tree still has to survive': conllu([
    '# text = el perro come',
    '1\tel\t_\tDET\t_\t_\t2\tdet\t_\t_',
    '2\tperro\t_\tNOUN\t_\t_\t3\tnsubj\t_\t_',
    '3\tcome\t_\tVERB\t_\t_\t0\troot\t_\t_',
  ]),
  'a head carrying no deprel of its own': conllu([
    '# text = a b',
    '1\ta\t_\tX\t_\t_\t_\t_\t_\t_',
    '2\tb\t_\tX\t_\t_\t1\tdep\t_\t_',
  ]),
  'two sentences, so the per-sentence wiring is exercised': conllu([
    '# text = uno',
    '1\tuno\t_\tNUM\t_\t_\t0\troot\t_\t_',
    '',
    '# text = dos tres',
    '1\tdos\tdos\tNUM\t_\t_\t2\tnummod\t_\t_',
    '2\ttres\t_\tNUM\t_\t_\t0\troot\t_\t_',
  ]),
  'no syntax at all': conllu(['# text = solo', '1\tsolo\tsolo\tADV\t_\t_\t_\t_\t_\t_']),
};

for (const [what, input] of Object.entries(CASES)) {
  test(`the importer writes what the mirror builds: ${what}`, async () => {
    const { info, client } = await imported(input);

    // Tokens, in creation order: sentences, then words, then morphemes.
    const bare = (t) => ({
      begin: t.begin,
      end: t.end,
      ...(t.precedence != null ? { precedence: t.precedence } : {}),
      ...(t.metadata ? { metadata: t.metadata } : {}),
    });
    const tokenLayers = ['sentenceTokenLayer', 'wordTokenLayer', 'morphemeTokenLayer'];
    assert.deepEqual(
      client.calls.tokens.flat().map((op) => [op.tokenLayerId, bare(op)]),
      tokenLayers.flatMap((k) => (info[k]?.tokens || []).map((t) => [info[k].id, bare(t)])),
      'the same tokens, in the same order',
    );

    // Spans, in the layer order the importer uses.
    assert.deepEqual(
      client.calls.spans.flat().map((op) => [op.spanLayerId, op.value ?? null]),
      SPAN_LAYERS.flatMap((k) => (info[k]?.spans || []).map((s) => [info[k].id, s.value ?? null])),
      'the same spans, in the same order',
    );

    // Relations by the POSITION of the lemma span each end names, so a
    // mis-wired head shows up rather than hiding behind different ids.
    const lemmaIds = [];
    for (const ops of client.calls.spans) {
      for (const op of ops) if (op.spanLayerId === info.lemmaLayer.id) lemmaIds.push(op);
    }
    const mintedLemma = new Map();
    {
      // The fake mints ids per batch call, in op order, from one counter.
      let next = 0;
      const minted = [];
      for (const ops of client.calls.tokens) for (const _ of ops) minted.push(`tokens-${next++}`);
      const spanMinted = [];
      for (const ops of client.calls.spans) {
        for (const op of ops) spanMinted.push([`spans-${next++}`, op]);
      }
      let k = 0;
      for (const [id, op] of spanMinted) {
        if (op.spanLayerId === info.lemmaLayer.id) mintedLemma.set(id, k++);
      }
    }
    const place = (id) => (mintedLemma.has(id) ? mintedLemma.get(id) : `unknown:${id}`);
    const mirrorLemmaPlace = new Map((info.lemmaLayer?.spans || []).map((s, i) => [s.id, i]));
    assert.deepEqual(
      client.calls.relations.flat().map((op) => [place(op.source), place(op.target), op.value]),
      (info.relationLayer?.relations || []).map((r) => [
        mirrorLemmaPlace.get(r.source),
        mirrorLemmaPlace.get(r.target),
        r.value,
      ]),
      'the same relations, between the same lemma spans',
    );
    assert.equal(lemmaIds.length, (info.lemmaLayer?.spans || []).length);
  });
}

test('an unlemmatized treebank keeps its dependency relations', () => {
  const input = CASES['an UNLEMMATIZED treebank, where every tree still has to survive'];
  const out = new ConlluDocument({ raw: rawDocFromConllu(input, 'u') }).toConllu();
  // HEAD and DEPREL come back, and LEMMA is still `_`: the relation hangs off
  // a null-valued Lemma span, which is the state a cleared lemma leaves too.
  assert.ok(out.includes('\t2\tdet\t'), out);
  assert.ok(out.includes('\t3\tnsubj\t'), out);
  assert.ok(out.includes('\t0\troot\t'), out);
  assert.ok(out.includes('1\tel\t_\tDET'), out);
});
