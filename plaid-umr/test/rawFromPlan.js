// A planned import laid into a raw document, in memory: what the storage
// model holds for a .umr file, for tests that need the document without a
// server. Not a test file itself, so the runner does not pick it up.
import { UMR_NAMESPACE } from '../src/utils/umrLayerUtils.js';

// What planImport writes, as the server would hand it back.
export function rawFromPlan(plan) {
  let n = 0;
  const id = () => `id${++n}`;
  const textId = id();
  const sentenceTokens = plan.sentences.map((s) => ({
    id: id(),
    begin: s.begin,
    end: s.end,
    metadata: { [UMR_NAMESPACE]: s.meta },
  }));
  const wordTokens = plan.sentences.flatMap((s) =>
    s.words.map((w) => ({ id: id(), begin: w.begin, end: w.end })),
  );
  const pieceTokens = plan.pieces.map((p) => ({ id: id(), begin: p.begin, end: p.end }));
  const spans = plan.nodes.map((node) => ({
    id: id(),
    tokens: node.pieceIndexes.map((i) => pieceTokens[i].id),
    value: node.concept,
    metadata: { [UMR_NAMESPACE]: node.meta },
  }));
  const spanOf = (key) => spans[plan.nodeIndex.get(key)].id;
  const relations = plan.edges.map((e) => ({
    id: id(),
    source: spanOf(e.source),
    target: spanOf(e.target),
    value: e.role,
    metadata: { [UMR_NAMESPACE]: { order: e.order } },
  }));
  const triples = plan.triples.map((t) => ({
    id: id(),
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
            tokens: pieceTokens,
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
