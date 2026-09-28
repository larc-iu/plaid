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
//   A word deleted under a node aligned to it (IGT deletes the word token,
//   the text stays) leaves the anchor over text with no word. The node
//   becomes an ordinary unaligned node: it records its sentence and stands
//   over it, so a later re-tokenize does not align it again without anyone
//   asking. The History entry names it.
//
// A node left outside every sentence is removed: there is no sentence for it
// to belong to and nothing on screen would show it. A stray kept is a
// fragment the annotator sees and deletes; a node removed is gone. A node
// that records no sentence and has a word under it is aligned, and is left
// alone.
//
// Three more repairs run in the same pass (the owner's rulings of
// 2026-09-28), each in its own function below: an anchor token no node
// stands on (an add cut off after its first request) is removed, a variable
// whose sentence number no longer matches its sentence is renumbered, and a
// node picked from a vocabulary entry that is gone forgets the entry.

/**
 * @param {{ sentences: Array, nodesById: Map }} graph from buildDocumentGraph
 * @param {string} namespace the metadata namespace a node records in
 * @returns {{
 *   remove: string[],
 *   rebind: { nodeId: string, sentenceTokenId: string }[],
 *   resize: { nodeId: string, pieceId: string, begin: number, end: number, extra?: string[] }[],
 *   unanchor: { nodeId: string, var: string, sentenceTokenId: string }[],
 * }}
 */
export function planUnalignedHeal(graph, namespace) {
  const { sentences, nodesById } = graph;
  const byToken = new Map(sentences.map((s) => [s.tokenId, s]));
  const recordOf = (node) => node.metadata?.[namespace]?.sentence || null;
  const remove = [];
  const rebind = [];
  const resize = [];
  const unanchor = [];
  // Its first piece put over the sentence. A node that lost two words apart
  // had two pieces, and the others go (`extra`).
  const standOver = (node, home) => {
    const [piece, ...rest] = node.pieces;
    if (!piece) return;
    if (piece.begin === home.begin && piece.end === home.end && !rest.length) return;
    const item = { nodeId: node.id, pieceId: piece.id, begin: home.begin, end: home.end };
    if (rest.length) item.extra = rest.map((p) => p.id);
    resize.push(item);
  };

  nodesById.forEach((node) => {
    if (node.constant) return;
    const record = recordOf(node);
    if (!record) {
      // A word deleted under it: no word overlaps its anchor any more
      // (sentenceGraph.js reads it as unaligned already). Bound to the
      // sentence it stands in and stretched over it.
      // Only an anchor over text: a point is what an older writer left
      // for a node it did not say was unaligned, and is read as one already.
      if (node.aligned || node.sentence == null) return;
      if (!node.pieces.some((p) => p.end > p.begin)) return;
      const home = sentences[node.sentence - 1];
      if (!home) return;
      unanchor.push({ nodeId: node.id, var: node.var, sentenceTokenId: home.tokenId });
      standOver(node, home);
      return;
    }
    // The sentence it belongs to: the one it records while that token is
    // alive, else the one it stands in.
    const home = byToken.get(record) || (node.sentence ? sentences[node.sentence - 1] : null);
    if (!home) {
      remove.push(node.id);
      return;
    }
    if (!byToken.has(record)) rebind.push({ nodeId: node.id, sentenceTokenId: home.tokenId });
    standOver(node, home);
  });
  return { remove, rebind, resize, unanchor };
}

/**
 * The anchor tokens no node stands on: what an add cut off after its first
 * request left (the token is made, then the concept on it, then the edge,
 * since core cannot name an id made earlier in the same batch). No screen
 * shows such a token and nothing can delete it. The node layer is UMR's own,
 * so no other app's data is at risk.
 *
 * @param {object} layerInfo from getUmrLayerInfo(raw)
 * @returns {string[]} token ids
 */
export function planStrayTokens(layerInfo) {
  const used = new Set((layerInfo.conceptLayer?.spans || []).flatMap((s) => s.tokens || []));
  return (layerInfo.nodeTokenLayer?.tokens || []).filter((t) => !used.has(t.id)).map((t) => t.id);
}

// `s<number><rest>`: the sentence number, then a letter and whatever follows.
const NUMBERED = /^s([0-9]+)(\p{L}.*)$/u;

/**
 * The variables whose sentence number is not their node's sentence, after
 * another app added or removed sentences before them: each renamed to its
 * sentence's number, keeping the rest of the name (`s2v` in sentence 1 is
 * `s1v`). A name already taken by a node that keeps its own takes a counter
 * after it, as a new variable does (`s1v2`). Constants and names not of this
 * shape are left alone. Relations point at nodes, so only the names change.
 *
 * @returns {{ nodeId: string, from: string, to: string }[]}
 */
export function planRenumber(graph, skip = new Set()) {
  const moves = [];
  const fixed = new Set();
  graph.nodesById.forEach((node) => {
    if (!node.var) return;
    const m = NUMBERED.exec(node.var);
    const wrong = !node.constant && node.sentence != null && m && Number(m[1]) !== node.sentence;
    if (wrong && !skip.has(node.id)) moves.push({ node, rest: m[2] });
    else fixed.add(node.var);
  });
  const taken = new Set(fixed);
  return moves
    .sort((a, b) => a.node.sentence - b.node.sentence || a.node.var.localeCompare(b.node.var))
    .map(({ node, rest }) => {
      const base = `s${node.sentence}${rest}`;
      let to = base;
      // The counter goes after the letters, as nextVariable counts.
      const stem = base.replace(/[0-9]+$/, '');
      for (let n = 2; taken.has(to); n++) to = `${stem}${n}`;
      taken.add(to);
      return { nodeId: node.id, from: node.var, to };
    });
}

/**
 * The nodes picked from a vocabulary entry that is no longer there, when the
 * lexicon read is known to be complete: each forgets the entry, since the
 * role picker and the entry check would otherwise ask after an id that
 * names nothing.
 *
 * @param {{ byId: Map }} lexicon from buildLexicon
 * @returns {string[]} node ids
 */
export function planEntryUnlink(graph, namespace, lexicon) {
  const out = [];
  graph.nodesById.forEach((node) => {
    const entry = node.metadata?.[namespace]?.entry;
    if (entry && !lexicon.byId.has(entry)) out.push(node.id);
  });
  return out;
}

const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** The audit label for what a pass changed, or null when it changed nothing. */
export function describeUmrReconcile({
  removed = 0,
  rebound = 0,
  resized = 0,
  strays = 0,
  unanchored = [],
  renumbered = 0,
  unlinked = 0,
} = {}) {
  const nodes = (n) => `${n} unaligned node${n === 1 ? '' : 's'}`;
  const parts = [];
  if (strays)
    parts.push(`removed ${count(strays, 'empty node', 'empty nodes')} an interrupted add left`);
  if (unanchored.length) {
    const names = unanchored.slice(0, 5).join(' ');
    const more = unanchored.length > 5 ? ` and ${unanchored.length - 5} more` : '';
    parts.push(
      unanchored.length === 1
        ? `1 node lost its word (${names})`
        : `${unanchored.length} nodes lost their words (${names}${more})`,
    );
  }
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
  if (renumbered) {
    parts.push(`renumbered ${count(renumbered, 'variable', 'variables')} to match the sentences`);
  }
  if (unlinked) {
    parts.push(`unlinked ${count(unlinked, 'node', 'nodes')} from a deleted vocabulary entry`);
  }
  return parts.length ? `Repaired: ${parts.join(', ')}` : null;
}
