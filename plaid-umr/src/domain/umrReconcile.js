// What reconcile-on-open heals in a UMR document: what another app's edit to
// the shared sentences left of an UNALIGNED node.
//
// An unaligned node's anchor is a zero-width token at its sentence's start,
// and it records the sentence it belongs to (`umr.sentence`, the sentence
// token's id). Core deletes a zero-width token only when a deletion straddles
// it on both sides, so deleting a whole sentence's text, which starts right at
// that point, leaves the node and shifts it to the start of the NEXT
// sentence, a stray among that sentence's own nodes and at the same place as
// them. Its recorded sentence is gone, and that is how it is told apart.
//
// A merge also takes a sentence token away (the right-hand one is merged into
// the left), but there the node sits INSIDE the merged sentence, not at a
// start, and it belongs to it. So a node whose recorded sentence is gone is:
//   inside a sentence   rebound to that sentence (a merge)
//   at a sentence start, or in none   removed (its sentence was deleted)
// A node that never recorded a sentence is left alone: there is no telling.

const isUnaligned = (node) => !node.constant && !node.aligned;

/**
 * @param {{ sentences: Array, nodesById: Map }} graph from buildDocumentGraph
 * @param {string} namespace the metadata namespace a node records in
 * @returns {{ remove: string[], rebind: { nodeId: string, sentenceTokenId: string }[] }}
 */
export function planUnalignedHeal(graph, namespace) {
  const alive = new Set(graph.sentences.map((s) => s.tokenId));
  const remove = [];
  const rebind = [];
  graph.nodesById.forEach((node) => {
    if (!isUnaligned(node)) return;
    const home = node.metadata?.[namespace]?.sentence;
    if (!home || alive.has(home)) return;
    const at = node.pieces[0]?.begin;
    const containing = node.sentence == null ? null : graph.sentences[node.sentence - 1];
    if (containing && at !== containing.begin) {
      rebind.push({ nodeId: node.id, sentenceTokenId: containing.tokenId });
    } else {
      remove.push(node.id);
    }
  });
  return { remove, rebind };
}

/** The audit label for what a pass changed, or null when it changed nothing. */
export function describeUmrReconcile({ removed = 0, rebound = 0 } = {}) {
  const parts = [];
  if (removed) {
    parts.push(
      `removed ${removed} unaligned node${removed === 1 ? '' : 's'} of a deleted sentence`,
    );
  }
  if (rebound) {
    parts.push(`rebound ${rebound} unaligned node${rebound === 1 ? '' : 's'} to a merged sentence`);
  }
  return parts.length ? `Reconcile: ${parts.join(', ')}` : null;
}
