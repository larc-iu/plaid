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
//
// And when NO record names a sentence of this document, the records came from
// somewhere else, not from deletions: a copy or an import that gave the rows
// new ids and did not rewrite the references to them. A deletion takes some
// sentences, never every one that holds an unaligned node while leaving the
// nodes. So then every node is bound to the sentence it is in, and nothing is
// removed.

const isUnaligned = (node) => !node.constant && !node.aligned;

/**
 * @param {{ sentences: Array, nodesById: Map }} graph from buildDocumentGraph
 * @param {string} namespace the metadata namespace a node records in
 * @returns {{ remove: string[], rebind: { nodeId: string, sentenceTokenId: string }[] }}
 */
export function planUnalignedHeal(graph, namespace) {
  const alive = new Set(graph.sentences.map((s) => s.tokenId));
  const recorded = [...graph.nodesById.values()].filter(
    (n) => isUnaligned(n) && n.metadata?.[namespace]?.sentence,
  );
  const foreign = !recorded.some((n) => alive.has(n.metadata[namespace].sentence));
  const remove = [];
  const rebind = [];
  recorded.forEach((node) => {
    if (alive.has(node.metadata[namespace].sentence)) return;
    const at = node.pieces[0]?.begin;
    const containing = node.sentence == null ? null : graph.sentences[node.sentence - 1];
    if (containing && (foreign || at !== containing.begin)) {
      rebind.push({ nodeId: node.id, sentenceTokenId: containing.tokenId });
    } else if (!foreign) {
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
    parts.push(
      `rebound ${rebound} unaligned node${rebound === 1 ? '' : 's'} to the sentence ${rebound === 1 ? 'it is' : 'they are'} in`,
    );
  }
  return parts.length ? `Reconcile: ${parts.join(', ')}` : null;
}
