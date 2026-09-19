// What reconcile-on-open heals in a UMR document: what another app's edit to
// the shared sentences left of a node aligned to no word.
//
// Such a node records the sentence it belongs to (`umr.sentence`, the
// sentence token's id), and that record is what says it is aligned to
// nothing. Its anchor is one token over the whole of that sentence, which is
// only where it stands: an edit anywhere in the text resizes the anchor with
// the sentence, and the node goes only when its sentence's text does, which
// is when it should. (It stood on a POINT at the sentence's start before, and
// core deletes a zero-width token a deletion spans, so joining two sentences
// by deleting across the boundary took the node with it.)
//
// Two things still need putting right after another app's edit, because a
// sentence token is not the same token afterwards:
//
//   A boundary taken away and put back (a merge and a split, a reset and a
//   re-split, a boundary toggled twice) leaves the sentence where it was
//   under a NEW token, and a sentence joined to the one before it keeps the
//   first sentence's token and drops the second's. Either way the record
//   names a token that is gone, and the node is bound to the sentence it
//   stands in.
//
//   A sentence's own extent changes as the text around it is edited, so an
//   anchor that no longer covers exactly the sentence it belongs to is put
//   back over it. That is also what turns an old point-anchored node into
//   the shape above, the first time its document is opened.
//
// A node left outside every sentence is removed: there is no sentence for it
// to belong to and nothing on screen would show it. Nothing else is removed.
// A stray kept is a fragment the annotator sees and deletes; a node removed
// is gone. A node that records no sentence is aligned to words, or was made
// by something that did not say, and is left alone either way.

/**
 * @param {{ sentences: Array, nodesById: Map }} graph from buildDocumentGraph
 * @param {string} namespace the metadata namespace a node records in
 * @returns {{
 *   remove: string[],
 *   rebind: { nodeId: string, sentenceTokenId: string }[],
 *   resize: { nodeId: string, pieceId: string, begin: number, end: number }[],
 * }}
 */
export function planUnalignedHeal(graph, namespace) {
  const { sentences, nodesById } = graph;
  const byToken = new Map(sentences.map((s) => [s.tokenId, s]));
  const recordOf = (node) => node.metadata?.[namespace]?.sentence || null;
  const remove = [];
  const rebind = [];
  const resize = [];

  nodesById.forEach((node) => {
    if (node.constant) return;
    const record = recordOf(node);
    if (!record) return;
    const piece = node.pieces[0];
    // The sentence it belongs to: the one it records while that token is
    // alive, else the one it stands in.
    const home = byToken.get(record) || (node.sentence ? sentences[node.sentence - 1] : null);
    if (!home) {
      remove.push(node.id);
      return;
    }
    if (!byToken.has(record)) rebind.push({ nodeId: node.id, sentenceTokenId: home.tokenId });
    if (piece && (piece.begin !== home.begin || piece.end !== home.end)) {
      resize.push({ nodeId: node.id, pieceId: piece.id, begin: home.begin, end: home.end });
    }
  });
  return { remove, rebind, resize };
}

/** The audit label for what a pass changed, or null when it changed nothing. */
export function describeUmrReconcile({ removed = 0, rebound = 0, resized = 0 } = {}) {
  const nodes = (n) => `${n} unaligned node${n === 1 ? '' : 's'}`;
  const parts = [];
  if (removed) parts.push(`removed ${nodes(removed)} left outside every sentence`);
  if (rebound) {
    parts.push(
      `rebound ${nodes(rebound)} to the sentence ${rebound === 1 ? 'it is' : 'they are'} in`,
    );
  }
  if (resized) {
    parts.push(
      `put ${nodes(resized)} back over ${resized === 1 ? 'its sentence' : 'their sentences'}`,
    );
  }
  return parts.length ? `Reconcile: ${parts.join(', ')}` : null;
}
