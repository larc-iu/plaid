// What reconcile-on-open heals in a UMR document: what another app's edit to
// the shared sentences left of an UNALIGNED node.
//
// An unaligned node's anchor is a zero-width token at its sentence's start,
// and it records the sentence it belongs to (`umr.sentence`, the sentence
// token's id). Three edits in another app move it or orphan it:
//
//   Text typed at the start of a sentence goes to the sentence before (core
//   gives an insert at a boundary to the sentence ending there), and the
//   node, left where it was, is now inside that one. Its record still names a
//   live sentence: it goes back to that sentence's start.
//
//   A sentence's text deleted: core deletes a zero-width token only when a
//   deletion straddles it, so the node outlives its sentence and lands at the
//   start of the next one, or past the end of the text. Its aligned
//   neighbours went with the words, so nothing of its graph is anchored in
//   the sentence it now sits in, and that sentence has a graph of its own. It
//   is removed.
//
//   A boundary taken away and put back (a merge and a split, a reset and a
//   re-split, a boundary toggled twice) leaves the sentence where it was
//   under a NEW token, so the record names a dead sentence here too. But the
//   node's graph came through whole, anchored in the sentence it sits in, or
//   it is the only graph that sentence has. It is bound to that sentence.
//
//   A sentence joined to the one before it keeps the first sentence's token
//   and drops the second's, so the second's nodes record a dead sentence
//   while every word they belong to is still there. They stand where that
//   sentence began, which is now INSIDE the joined sentence: a node away
//   from a sentence's start is a node whose text came through a join, and it
//   is bound to the sentence it is in.
//
// So a node whose record is dead is removed only when all three hold: it
// stands at the start of the sentence it is in, no aligned node of its own
// graph is in that sentence, and that sentence has nodes of another graph
// (not joined to it, and not recording the same dead sentence). When in
// doubt it is kept: a stray kept is a fragment the annotator sees and
// deletes, a node removed is gone. A node that never recorded a sentence is
// left alone, there being no telling.

const isUnaligned = (node) => !node.constant && !node.aligned;

/**
 * @param {{ sentences: Array, nodesById: Map }} graph from buildDocumentGraph
 * @param {string} namespace the metadata namespace a node records in
 * @returns {{
 *   remove: string[],
 *   rebind: { nodeId: string, sentenceTokenId: string }[],
 *   move: { nodeId: string, pieceId: string, to: number }[],
 * }}
 */
export function planUnalignedHeal(graph, namespace) {
  const { sentences, nodesById } = graph;
  const byToken = new Map(sentences.map((s) => [s.tokenId, s]));
  const recordOf = (node) => node.metadata?.[namespace]?.sentence || null;
  const remove = [];
  const rebind = [];
  const move = [];

  // A node's graph: every node an edge of its sentence graph joins it to,
  // whichever way the edge runs.
  const graphOf = (start) => {
    const seen = new Set([start.id]);
    const stack = [start];
    while (stack.length) {
      const n = stack.pop();
      [...n.out.map((e) => e.target), ...n.in.map((e) => e.source)].forEach((id) => {
        const next = nodesById.get(id);
        if (next && !next.constant && !seen.has(id)) {
          seen.add(id);
          stack.push(next);
        }
      });
    }
    return seen;
  };

  nodesById.forEach((node) => {
    if (!isUnaligned(node)) return;
    const record = recordOf(node);
    if (!record) return;
    const piece = node.pieces[0];
    const home = byToken.get(record);
    if (home) {
      // Its sentence is alive: the node belongs at its start, and is moved
      // back there when an edit elsewhere left it in another sentence.
      if (node.sentence !== home.index && piece) {
        move.push({ nodeId: node.id, pieceId: piece.id, to: home.begin });
      }
      return;
    }
    const here = node.sentence == null ? null : sentences[node.sentence - 1];
    if (!here) {
      remove.push(node.id);
      return;
    }
    const own = graphOf(node);
    const anchoredHere = [...own].some((id) => {
      const n = nodesById.get(id);
      return !isUnaligned(n) && n.sentence === here.index;
    });
    // Away from the start: the sentence it belongs to was joined to this one,
    // and its words are here.
    const atStart = piece ? piece.begin === here.begin : true;
    // Of another graph: not joined to this one, nor a node that records the
    // same sentence (a fragment of the same graph, come through the same way).
    const others = here.nodes.some(
      (n) => !n.constant && !own.has(n.id) && !(isUnaligned(n) && recordOf(n) === record),
    );
    if (atStart && !anchoredHere && others) remove.push(node.id);
    else rebind.push({ nodeId: node.id, sentenceTokenId: here.tokenId });
  });
  return { remove, rebind, move };
}

/** The audit label for what a pass changed, or null when it changed nothing. */
export function describeUmrReconcile({ removed = 0, rebound = 0, moved = 0 } = {}) {
  const nodes = (n) => `${n} unaligned node${n === 1 ? '' : 's'}`;
  const parts = [];
  if (removed) parts.push(`removed ${nodes(removed)} of a deleted sentence`);
  if (rebound) {
    parts.push(
      `rebound ${nodes(rebound)} to the sentence ${rebound === 1 ? 'it is' : 'they are'} in`,
    );
  }
  if (moved) {
    parts.push(
      `moved ${nodes(moved)} back to the start of ${moved === 1 ? 'its' : 'their'} sentence`,
    );
  }
  return parts.length ? `Reconcile: ${parts.join(', ')}` : null;
}
