// A planned import laid into a raw document, in memory: what the storage
// model holds for a .umr file, for tests that need the document without a
// server. Not a test file itself, so the runner does not pick it up.
import { UMR_NAMESPACE } from '../src/utils/umrLayerUtils.js';

// What planImport writes, as the server would hand it back.
export function rawFromPlan(plan) {
  let n = 0;
  const id = () => `id${++n}`;
  const textId = id();
  const sentenceTokens = plan.sentences.map((s) => ({ id: id(), begin: s.begin, end: s.end }));
  const wordTokens = plan.sentences.flatMap((s) =>
    s.words.map((w) => ({ id: id(), begin: w.begin, end: w.end })),
  );
  const pieceTokens = plan.pieces.map((p) => ({ id: id(), begin: p.begin, end: p.end }));
  // Each sentence's record, a token of the node layer over the sentence
  // (umrImport.js), listing the triples between two constants its block
  // writes by their ids.
  const tripleIds = plan.triples.map(() => id());
  const recordTokens = plan.sentences.map((s) => {
    const triples = s.triples.map((ref) => (typeof ref === 'number' ? tripleIds[ref] : ref));
    return {
      id: id(),
      begin: s.begin,
      end: s.end,
      metadata: { [UMR_NAMESPACE]: triples.length ? { ...s.meta, triples } : s.meta },
    };
  });
  // `home` is the sentence a node aligned to no word belongs to, which the
  // import records as that sentence's token id (umrImport.js). The record is
  // what says the node is aligned to nothing, so a raw document without it
  // reads every such node as covering its whole sentence's words.
  const spans = plan.nodes.map((node) => ({
    id: id(),
    tokens: node.pieceIndexes.map((i) => pieceTokens[i].id),
    value: node.concept,
    metadata: {
      [UMR_NAMESPACE]: node.home
        ? { ...node.meta, sentence: sentenceTokens[node.home - 1].id }
        : node.meta,
    },
  }));
  const spanOf = (key) => spans[plan.nodeIndex.get(key)].id;
  const relations = plan.edges.map((e) => ({
    id: id(),
    source: spanOf(e.source),
    target: spanOf(e.target),
    value: e.role,
    metadata: { [UMR_NAMESPACE]: { order: e.order } },
  }));
  const triples = plan.triples.map((t, i) => ({
    id: tripleIds[i],
    source: spanOf(t.source),
    target: spanOf(t.target),
    value: t.rel,
    metadata: { [UMR_NAMESPACE]: t.meta },
  }));
  const role = (r) => ({ plaid: { role: r } });
  return {
    id: 'doc',
    name: 'doc',
    textLayers: [
      {
        id: id(),
        config: role('baseline'),
        text: { id: textId, body: plan.body },
        tokenLayers: [
          { id: id(), config: role('sentence'), tokens: sentenceTokens, spanLayers: [] },
          { id: id(), config: role('word'), tokens: wordTokens, spanLayers: [] },
          {
            id: id(),
            config: { [UMR_NAMESPACE]: { nodes: true } },
            tokens: [...pieceTokens, ...recordTokens],
            spanLayers: [
              {
                id: id(),
                config: { [UMR_NAMESPACE]: { concepts: true } },
                spans,
                relationLayers: [
                  { id: id(), config: { [UMR_NAMESPACE]: { relations: true } }, relations },
                  {
                    id: id(),
                    config: { [UMR_NAMESPACE]: { documentGraph: true } },
                    relations: triples,
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}
