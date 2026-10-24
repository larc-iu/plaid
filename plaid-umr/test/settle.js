// What the next UMR write to every sentence of a document stores of what the
// reader shows (umrSettle.js), sent on the document's own client, and a
// count of it by kind, for the tests of what each kind stores. That a real
// write sends exactly this is settleOnWrite.test.js's. Not a test file
// itself, so the runner does not pick it up.
import { recordShares } from '../src/domain/sentenceGraph.js';
import { planSettle, queueSettle } from '../src/domain/umrSettle.js';

/**
 * Store, on `doc`'s client, what a write to each sentence would. Resolves to
 * null when there is nothing to store, else to the count by kind:
 * `{ renumbered, rebound, unanchored, wordSplits, recordsMoved,
 * recordsFitted, plan }`.
 */
export async function storeAll(doc) {
  const graph = doc.graph;
  const plan = planSettle(graph, null);
  if (!plan) return null;
  const shares = recordShares(graph);
  const changes = [...plan.meta].map(([id, c]) => [graph.nodesById.get(id), c]);
  const tally = {
    plan,
    renumbered: changes.filter(([, c]) => c.var).length,
    rebound: changes.filter(([n, c]) => c.sentence && n?.metadata?.umr?.sentence).length,
    unanchored: changes
      .filter(([n, c]) => c.sentence && !n?.metadata?.umr?.sentence)
      .map(([n]) => n.var),
    wordSplits: changes.filter(([, c]) => Array.isArray(c.words)).length,
    recordsMoved: shares.filter((r) => r.moved).length,
    recordsFitted: shares.filter((r) => !r.moved).length,
  };
  await doc._client.batched((b) => queueSettle(b, plan));
  return tally;
}
