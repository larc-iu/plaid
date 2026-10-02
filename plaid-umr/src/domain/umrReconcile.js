// What reconcile-on-open heals in a UMR document: what another app's edit to
// the shared sentences left of a node aligned to no word.
//
// Such a node records the sentence it belongs to (`umr.sentence`, the
// sentence token's id), and that record is what says it is aligned to
// nothing. Its anchor is one token over the whole of that sentence when it
// is made, which is only where it stands: an edit in the text resizes the
// anchor with the sentence, and the node goes only when the text under it
// does. (It stood on a POINT at the sentence's start before, and
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
//   anchor that reaches out of the sentence it belongs to is cut back to
//   it, and one on a point is put over it. An anchor of text inside the
//   sentence is left: a node of a sentence joined to the one before keeps
//   standing over its old half, and a split at the same place puts it back
//   with its relations.
//
//   A word deleted under a node aligned to it (IGT deletes the word token,
//   the text stays) leaves the anchor over text with no word. The node
//   becomes an ordinary unaligned node: it records its sentence, so a later
//   re-tokenize does not align it again without anyone asking, and keeps
//   standing over its word's text, so a split before or after that text
//   leaves it with its relations. The History entry names it.
//
// A node left outside every sentence is removed: there is no sentence for it
// to belong to and nothing on screen would show it. A stray kept is a
// fragment the annotator sees and deletes; a node removed is gone. A node
// that records no sentence and has a word under it is aligned, and is left
// alone.
//
// More repairs run in the same pass (the owner's rulings of 2026-09-28),
// each in its own function below: an anchor token no node stands on (an add
// cut off after its first request) is removed, a variable whose sentence
// number no longer matches its sentence is renumbered, a sentence's record
// left on new text split off before it moves to the sentence it describes, a
// triple between two constants takes its sentences' numbers now, and a node
// picked from a vocabulary entry that is gone forgets the entry.

import { NUMBERED_VARIABLE, numberedByFile, sentenceNumberReader } from './sentenceGraph.js';
import { countOf } from '../../../plaid-ui/src/lib/plural.js';

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
  const recordOf = (node) => node.metadata?.[namespace]?.sentence || null;
  const remove = [];
  const rebind = [];
  const resize = [];
  const unanchor = [];
  // An unaligned node's anchor made one stretch of text inside its
  // sentence: from where its first piece of text begins to where its last
  // ends, cut to the sentence, and the whole sentence when it covers no text
  // there (a point). An anchor that is one such stretch already is left
  // where it is. Never stretched further: after two sentences are joined, or
  // a word is deleted under a node, the node keeps standing over its own
  // text, so a split of the sentence at a point outside that text leaves
  // the node, and its relations, on the side its text is on. A node that
  // lost two words apart had two pieces, and the others go (`extra`).
  const standOver = (node, home) => {
    const [piece, ...rest] = node.pieces;
    if (!piece) return;
    const text = node.pieces.filter((p) => p.end > p.begin);
    let begin = Math.max(home.begin, Math.min(...text.map((p) => p.begin)));
    let end = Math.min(home.end, Math.max(...text.map((p) => p.end)));
    if (!text.length || end <= begin) [begin, end] = [home.begin, home.end];
    if (piece.begin === begin && piece.end === end && !rest.length) return;
    const item = { nodeId: node.id, pieceId: piece.id, begin, end };
    if (rest.length) item.extra = rest.map((p) => p.id);
    resize.push(item);
  };

  nodesById.forEach((node) => {
    if (node.constant) return;
    const record = recordOf(node);
    if (!record) {
      // A word deleted under it: no word overlaps its anchor any more
      // (sentenceGraph.js reads it as unaligned already). Bound to the
      // sentence it stands in, over the text its word had.
      // Only an anchor over text: a point is what an older writer left
      // for a node it did not say was unaligned, and is read as one already.
      if (node.aligned || node.sentence == null) return;
      if (!node.pieces.some((p) => p.end > p.begin)) return;
      const home = sentences[node.sentence - 1];
      // A sentence with no words at all is waiting to be tokenized again
      // (IGT's "Clear tokens"), not a deletion: its nodes are left where they
      // stand, and the words that come back align them as before.
      if (!home || !home.words.length) return;
      unanchor.push({ nodeId: node.id, var: node.var, sentenceTokenId: home.tokenId });
      standOver(node, home);
      return;
    }
    // The sentence it belongs to, as sentenceGraph.js reads it: the one it
    // records while that token is alive and the anchor does not begin in a
    // later one, else the one it stands in.
    const home = node.sentence ? sentences[node.sentence - 1] : null;
    if (!home) {
      remove.push(node.id);
      return;
    }
    if (home.tokenId !== record) rebind.push({ nodeId: node.id, sentenceTokenId: home.tokenId });
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

/**
 * The variables whose sentence number is not their node's sentence, after
 * another app added or removed sentences before them: each renamed to its
 * sentence's number, keeping the rest of the name (`s2v` in sentence 1 is
 * `s1v`). A name already taken by a node that keeps its own takes a counter
 * after it, as a new variable does (`s1v2`). Constants and names not of this
 * shape are left alone. Relations point at nodes, so only the names change.
 * `reserved` holds names taken by something that is not a node, the
 * variables a graph kept as text defines. Nothing is renamed in a document
 * that goes by its file's numbers, whose first stored `# :: snt` number is
 * not 1, as a released excerpt starting at snt5 (`numberedByFile`). A
 * sentence deleted or merged later in an imported file does not stop it: the
 * numbers after it no longer run, and are then read by position.
 *
 * @returns {{ nodeId: string, from: string, to: string }[]}
 */
export function planRenumber(graph, skip = new Set(), reserved = new Set()) {
  if (numberedByFile(graph.sentences || [])) return [];
  const moves = [];
  const fixed = new Set(reserved);
  graph.nodesById.forEach((node) => {
    if (!node.var) return;
    const m = NUMBERED_VARIABLE.exec(node.var);
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
 * The sentence records to move to the sentence they describe, as the reader
 * found them (sentenceGraph.js `recordsFollowTheirGraphs`): IGT's split kept
 * a sentence's token, and the record on it, on the new text typed in before
 * it. Each is `{ from, to }`, sentence token ids.
 *
 * @returns {{ from: string, to: string }[]}
 */
export function planRecordMoves(graph) {
  return (graph.sentences || [])
    .filter((s) => s.recordToken && s.recordToken !== s.tokenId)
    .map((s) => ({ from: s.recordToken, to: s.tokenId }));
}

/**
 * The triples between two constants whose stored sentence numbers no longer
 * name the sentences whose blocks write them, after another app added or
 * removed a sentence before those: each with the numbers it is read by now
 * (sentenceGraph.js `sentenceNumberReader`), written in the same pass that
 * renumbers the variables.
 *
 * @returns {{ relationId: string, sentences: number[] }[]}
 */
export function planTripleNumbers(graph, namespace) {
  const numberNow = sentenceNumberReader(graph.sentences || []);
  const out = [];
  const seen = new Set();
  (graph.constants || []).forEach((c) =>
    c.docOut.forEach((t) => {
      if (seen.has(t.id) || !graph.nodesById.get(t.target)?.constant) return;
      seen.add(t.id);
      const stored = t.metadata?.[namespace]?.sentences || [];
      const now = [...new Set(stored.map(numberNow))];
      if (now.length !== stored.length || now.some((n, i) => n !== stored[i])) {
        out.push({ relationId: t.id, sentences: now });
      }
    }),
  );
  return out;
}

/**
 * The nodes picked from a vocabulary entry that was deleted: each forgets the
 * entry, since the role picker and the entry check would otherwise ask after
 * an id that names nothing. A node records the vocabulary it picked from
 * (`entryVocab`), and the entry counts as deleted only when that vocabulary
 * was read and lacks it. A vocabulary unlinked from the project is not read,
 * and may be linked again, so the nodes picked from it keep their entries.
 * So does a node that does not say which vocabulary its entry is in: nothing
 * tells a deleted entry from one in a vocabulary this person cannot read.
 *
 * @param {{ byId: Map }} lexicon from buildLexicon
 * @param {Set<string>} readVocabs the vocabularies that were read whole
 * @returns {string[]} node ids
 */
export function planEntryUnlink(graph, namespace, lexicon, readVocabs) {
  const out = [];
  graph.nodesById.forEach((node) => {
    const { entry, entryVocab } = node.metadata?.[namespace] || {};
    if (entry && readVocabs.has(entryVocab) && !lexicon.byId.has(entry)) out.push(node.id);
  });
  return out;
}

/** The audit label for what a pass changed, or null when it changed nothing. */
export function describeUmrReconcile({
  removed = 0,
  rebound = 0,
  resized = 0,
  strays = 0,
  unanchored = [],
  renumbered = 0,
  unlinked = 0,
  recordsMoved = 0,
  triplesMoved = 0,
  rulesDeclared = false,
  rulesRepaired = false,
} = {}) {
  const nodes = (n) => `${n} unaligned node${n === 1 ? '' : 's'}`;
  const parts = [];
  // The rule on UMR relations (umrConstraints.js): core deletes what breaks
  // it, then holds it.
  if (rulesRepaired) parts.push('removed relations that crossed sentences');
  if (rulesDeclared)
    parts.push('set up the rules that a relation stays inside its sentence and closes no cycle');
  if (strays)
    parts.push(`removed ${countOf(strays, 'empty node', 'empty nodes')} an interrupted add left`);
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
  if (recordsMoved) {
    parts.push(
      recordsMoved === 1
        ? 'moved the stored lines of 1 sentence to the sentence they describe'
        : `moved the stored lines of ${recordsMoved} sentences to the sentences they describe`,
    );
  }
  if (triplesMoved) {
    parts.push(
      `moved ${countOf(triplesMoved, 'document-level relation', 'document-level relations')} between constants to ${triplesMoved === 1 ? 'its sentences' : 'their sentences'}`,
    );
  }
  if (renumbered) {
    parts.push(`renumbered ${countOf(renumbered, 'variable', 'variables')} to match the sentences`);
  }
  if (unlinked) {
    parts.push(`unlinked ${countOf(unlinked, 'node', 'nodes')} from a deleted vocabulary entry`);
  }
  return parts.length ? `Repaired: ${parts.join(', ')}` : null;
}
