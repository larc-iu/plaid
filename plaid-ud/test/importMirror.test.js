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

/**
 * A client that records the bulk creates and hands back ids for them. The
 * importer makes every write on a batch, so the bulk creates live on the batch
 * `batched` hands it.
 */
function recordingClient() {
  let n = 0;
  const calls = { tokens: [], spans: [], relations: [] };
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
    batched: async (fn) => {
      const queued = [];
      const queue = (kind, ops) => {
        queued.push({ kind, ops });
        calls[kind].push(ops);
      };
      const batch = {
        tokens: { bulkCreate: (ops) => queue('tokens', ops) },
        spans: { bulkCreate: (ops) => queue('spans', ops) },
        relations: { bulkCreate: (ops) => queue('relations', ops) },
      };
      await fn(batch);
      return queued.map(({ kind, ops }) => ({ body: { ids: ops.map(() => `${kind}-${n++}`) } }));
    },
  };
}

/** The span layers in the order the importer creates them. */
const SPAN_LAYERS = ['formLayer', 'lemmaLayer', 'uposLayer', 'xposLayer', 'featuresLayer'];

async function imported(input, options) {
  const mirror = rawDocFromConllu(input, 'm', options);
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

// An enhanced graph: a shared subject (a second head), a relabel (the basic
// relation suppressed and the new label added), a row that restates its tree,
// and an unlemmatized head that only an enhanced edge reaches.
const ENHANCED = conllu([
  '# text = she came and left home',
  '1\tshe\t_\tPRON\t_\t_\t2\tnsubj\t2:nsubj|4:nsubj\t_',
  '2\tcame\tcome\tVERB\t_\t_\t0\troot\t0:root\t_',
  '3\tand\tand\tCCONJ\t_\t_\t4\tcc\t4:cc\t_',
  '4\tleft\t_\tVERB\t_\t_\t2\tconj\t2:conj:and\t_',
  '5\thome\thome\tNOUN\t_\t_\t4\tobj\t_\t_',
]);

const ALL_CASES = [
  ...Object.entries(CASES).map(([what, input]) => [what, input, undefined]),
  ['an enhanced graph, into a project that annotates one', ENHANCED, { enhanced: true }],
  ['an enhanced graph, into a project that does not', ENHANCED, undefined],
];

for (const [what, input, options] of ALL_CASES) {
  test(`the importer writes what the mirror builds: ${what}`, async () => {
    const { info, client } = await imported(input, options);

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
      client.calls.relations
        .flat()
        .map((op) => [
          op.relationLayerId,
          place(op.source),
          place(op.target),
          op.value,
          op.metadata ?? null,
        ]),
      [info.relationLayer, info.enhancedRelationLayer]
        .filter(Boolean)
        .flatMap((layer) =>
          (layer.relations || []).map((r) => [
            layer.id,
            mirrorLemmaPlace.get(r.source),
            mirrorLemmaPlace.get(r.target),
            r.value,
            r.metadata ?? null,
          ]),
        ),
      'the same relations, in the same layers, between the same lemma spans',
    );
    assert.equal(lemmaIds.length, (info.lemmaLayer?.spans || []).length);
  });
}

// The importer reads a FEATS pair through the same one reader the cell and the
// document write use (src/utils/feats.js), so an off-spec `Gender = Masc` in a
// file is stored under the name a typed pair would be, and an entry with no
// value at all is nothing to store.
test('the importer trims a FEATS pair and drops one with no value', async () => {
  const input = conllu([
    '# text = perro',
    '1\tperro\tperro\tNOUN\t_\tGender = Masc|Number=|Definite=Def\t0\troot\t_\t_',
  ]);
  const info = getUdLayerInfo(rawDocFromConllu(input, 'm'));
  const client = recordingClient();
  await ConlluDocument.importFromConllu(client, 'p1', 'm', input, info);

  const written = client.calls.spans
    .flat()
    .filter((op) => op.spanLayerId === info.featuresLayer.id)
    .map((op) => op.value);
  assert.deepEqual(written, ['Gender=Masc', 'Definite=Def']);
});

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

test('an enhanced graph comes back out of DEPS as it went in', () => {
  const out = new ConlluDocument({
    raw: rawDocFromConllu(ENHANCED, 'e', { enhanced: true }),
  }).toConllu();
  assert.ok(out.includes('\t2\tnsubj\t2:nsubj|4:nsubj\t'), out);
  assert.ok(out.includes('\t0\troot\t0:root\t'), out);
  // The relabel: the tree keeps `conj`, the graph has `conj:and` alone.
  assert.ok(out.includes('\t2\tconj\t2:conj:and\t'), out);
  // A row that said nothing about the graph follows its tree.
  assert.ok(out.includes('\t4\tobj\t4:obj\t'), out);
});

test('a project that does not annotate the enhanced graph says what it dropped', async () => {
  const info = getUdLayerInfo(rawDocFromConllu(ENHANCED, 'm'));
  const out = await ConlluDocument.importFromConllu(recordingClient(), 'p1', 'm', ENHANCED, info);
  // One extra head, and a relabel that is a suppressor and an extra.
  assert.deepEqual(out.importWarnings, [
    '3 enhanced dependencies dropped: this project does not annotate enhanced dependencies.',
  ]);
});

test('an enhanced dependency from an empty node is dropped with the node', async () => {
  const input = conllu([
    '# text = Mary tea John coffee',
    '1\tMary\t_\tPROPN\t_\t_\t0\troot\t0:root\t_',
    '2\ttea\t_\tNOUN\t_\t_\t1\tobj\t1:obj\t_',
    '3\tJohn\t_\tPROPN\t_\t_\t1\tconj\t3.1:nsubj\t_',
    '3.1\tordered\t_\tVERB\t_\t_\t_\t_\t1:conj\t_',
    '4\tcoffee\t_\tNOUN\t_\t_\t3\torphan\t3.1:obj\t_',
  ]);
  const info = getUdLayerInfo(rawDocFromConllu(input, 'm', { enhanced: true }));
  const client = recordingClient();
  const out = await ConlluDocument.importFromConllu(client, 'p1', 'm', input, info);
  assert.deepEqual(out.importWarnings, [
    '1 empty node (decimal-ID rows) and 2 enhanced dependencies from an empty node dropped: ' +
      'Plaid UD does not store empty nodes.',
  ]);
  // With its empty node gone a row follows its tree, so nothing is written to
  // the enhanced layer and the `orphan` analysis is what stands.
  const enhancedOps = client.calls.relations
    .flat()
    .filter((op) => op.relationLayerId === info.enhancedRelationLayer.id);
  assert.deepEqual(enhancedOps, []);
});
