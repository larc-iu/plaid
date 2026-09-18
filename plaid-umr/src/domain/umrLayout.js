// The canvas layout: where each node of a sentence graph sits, and the path
// of each edge. Pure, so it is tested on the sample corpora without a DOM.
//
// Rows are depth from the root, root at the top, tokens below the deepest row.
// Within a row every node prefers the x of its anchor (an unaligned node, its
// parent's x) and the row is then placed as a whole with the least total
// displacement that leaves a gap between neighbors. Rows are placed one at a
// time rather than as subtrees with contours: contours keep a subtree compact
// by pulling its nodes off their anchors, and a node over its own token is the
// point of the canvas. See docs/umr/CANVAS.md.

export const DEFAULT_OPTIONS = Object.freeze({
  rowHeight: 64,
  nodeHeight: 36,
  gap: 12,
  marginTop: 16,
  marginBottom: 20,
  // How far above a child its tree edge's label floats.
  labelLift: 13,
  // What a node measures before the DOM has measured it: enough for the
  // variable, the concept and a chip or two.
  estimateWidth: (node) => Math.max(64, 16 + 7.5 * (node.concept.length + 4)),
});

/**
 * Which of a node's outgoing edges are TREE edges: the first edge reaching
 * each node in a depth-first walk from the roots in stored child order. Every
 * other edge is re-entrant. The same rule decides which site expands a node
 * inline in the file, so the tree on the canvas is the tree in the export.
 *
 * @param {object} sentence from buildDocumentGraph
 * @param {Map} nodesById
 * @returns {{ treeEdgeIds: Set<string>, parentOf: Map<string, string>, depthOf: Map<string, number>, order: string[] }}
 */
export function treeOf(sentence, nodesById) {
  const treeEdgeIds = new Set();
  const parentOf = new Map();
  const depthOf = new Map();
  const order = [];
  const inSentence = (id) => nodesById.get(id)?.sentence === sentence.index;
  const visit = (node, depth) => {
    depthOf.set(node.id, depth);
    order.push(node.id);
    [...node.out]
      .sort((a, b) => a.order - b.order)
      .forEach((edge) => {
        if (!inSentence(edge.target) || depthOf.has(edge.target)) return;
        treeEdgeIds.add(edge.id);
        parentOf.set(edge.target, node.id);
        visit(nodesById.get(edge.target), depth + 1);
      });
  };
  sentence.roots.forEach((root) => {
    if (!depthOf.has(root.id)) visit(root, 0);
  });
  // A node reachable from no root (a cycle with no way in) still needs a row.
  sentence.nodes.forEach((node) => {
    if (!depthOf.has(node.id)) visit(node, 0);
  });
  return { treeEdgeIds, parentOf, depthOf, order };
}

// Least-squares placement of one row: items sorted by preferred x, each with
// a width, no two closer than the gap, every item as near its preference as
// the others allow. With `d_i` the room the items before `i` need, the
// constraint "left_i >= left_{i-1} + width + gap" is "left_i - d_i is
// nondecreasing", and the least-squares fit of a nondecreasing sequence is
// isotonic regression: pool adjacent violators, each pool at its mean.
export function placeRow(items, gap) {
  const sorted = [...items].sort((a, b) => a.pref - b.pref || a.tie - b.tie);
  let d = 0;
  const u = sorted.map((item) => {
    const value = item.pref - item.width / 2 - d;
    d += item.width + gap;
    return value;
  });
  // Pools of consecutive items, merged while a pool's mean falls below the
  // one before it.
  const pools = [];
  u.forEach((value) => {
    let pool = { sum: value, count: 1 };
    while (
      pools.length &&
      pools[pools.length - 1].sum / pools[pools.length - 1].count > pool.sum / pool.count
    ) {
      const prev = pools.pop();
      pool = { sum: prev.sum + pool.sum, count: prev.count + pool.count };
    }
    pools.push(pool);
  });
  const positions = new Map();
  let i = 0;
  d = 0;
  pools.forEach((pool) => {
    const fit = pool.sum / pool.count;
    for (let k = 0; k < pool.count; k++, i++) {
      const item = sorted[i];
      positions.set(item.id, fit + d + item.width / 2);
      d += item.width + gap;
    }
  });
  return positions;
}

/**
 * Lay out one sentence's graph.
 *
 * @param {object} sentence from buildDocumentGraph
 * @param {Map} nodesById
 * @param {object} measures `{ columns: Map<wordId, {x, left, right}>, sizes: Map<nodeId, {width, height}>, sentenceX }`
 *   `columns` are the word columns' centers, `sizes` the measured node boxes
 *   (missing ones are estimated), `sentenceX` where an unanchored root goes.
 * @param {object} [options]
 * @returns {{ nodes: Map<nodeId, {x, y, width, height, row}>, edges: Array, height: number, rows: number, tree: object }}
 */
export function layoutSentence(sentence, nodesById, measures, options = {}) {
  const opt = { ...DEFAULT_OPTIONS, ...options };
  const tree = treeOf(sentence, nodesById);
  const { columns, sizes, sentenceX = 0 } = measures;

  const sizeOf = (node) =>
    sizes?.get(node.id) || { width: opt.estimateWidth(node), height: opt.nodeHeight };

  // Preferred x. An aligned node prefers its anchor. An unaligned node sits
  // over the mean of its children (so `and` lands between its conjuncts and
  // an abstract root over its arguments), and failing that under its parent,
  // and failing that at the sentence's start. Children before parents for
  // the first rule, parents before children for the second.
  const anchored = new Map();
  const childrenOf = new Map();
  tree.order.forEach((id) => {
    const node = nodesById.get(id);
    const xs = (node.wordIds || []).map((w) => columns.get(w)?.x).filter((x) => x != null);
    if (xs.length) anchored.set(id, xs.reduce((a, b) => a + b, 0) / xs.length);
    const parent = tree.parentOf.get(id);
    if (parent) {
      if (!childrenOf.has(parent)) childrenOf.set(parent, []);
      childrenOf.get(parent).push(id);
    }
  });
  const fromBelow = new Map();
  [...tree.order].reverse().forEach((id) => {
    if (anchored.has(id)) {
      fromBelow.set(id, anchored.get(id));
      return;
    }
    const below = (childrenOf.get(id) || []).map((c) => fromBelow.get(c)).filter((x) => x != null);
    if (below.length) fromBelow.set(id, below.reduce((a, b) => a + b, 0) / below.length);
  });
  const pref = new Map();
  tree.order.forEach((id) => {
    let x = fromBelow.get(id);
    if (x == null) x = tree.parentOf.has(id) ? pref.get(tree.parentOf.get(id)) : sentenceX;
    pref.set(id, x);
  });

  // Rows.
  const rows = new Map();
  tree.order.forEach((id) => {
    const depth = tree.depthOf.get(id);
    if (!rows.has(depth)) rows.set(depth, []);
    rows.get(depth).push(id);
  });
  const rowCount = rows.size;

  const nodes = new Map();
  rows.forEach((ids, depth) => {
    const items = ids.map((id, i) => ({
      id,
      pref: pref.get(id),
      tie: i,
      width: sizeOf(nodesById.get(id)).width,
    }));
    const xs = placeRow(items, opt.gap);
    ids.forEach((id) => {
      const size = sizeOf(nodesById.get(id));
      nodes.set(id, {
        x: xs.get(id),
        y: opt.marginTop + depth * opt.rowHeight,
        width: size.width,
        height: size.height,
        row: depth,
      });
    });
  });

  const height = opt.marginTop + Math.max(rowCount, 1) * opt.rowHeight + opt.marginBottom;

  const edges = sentence.edges
    .filter((e) => nodes.has(e.source) && nodes.has(e.target))
    .map((edge) => {
      const s = nodes.get(edge.source);
      const t = nodes.get(edge.target);
      const isTree = tree.treeEdgeIds.has(edge.id);
      return {
        id: edge.id,
        source: edge.source,
        target: edge.target,
        role: edge.role,
        tree: isTree,
        path: isTree ? treePath(s, t) : reentrantPath(s, t, opt),
        label: labelPoint(s, t, isTree, opt),
      };
    });

  return { nodes, edges, height, rows: rowCount, tree };
}

// Bottom center of the parent to top center of the child. The tangents are
// vertical at both ends and long, so an edge leaves straight down, runs
// across the gap, and arrives straight up, instead of slicing under the
// parent's neighbors on a long reach.
function treePath(s, t) {
  const x1 = s.x;
  const y1 = s.y + s.height;
  const x2 = t.x;
  const y2 = t.y;
  const k = Math.max(16, (y2 - y1) * 0.9);
  return `M ${r(x1)} ${r(y1)} C ${r(x1)} ${r(y1 + k)}, ${r(x2)} ${r(y2 - k)}, ${r(x2)} ${r(y2)}`;
}

// A re-entrant edge leaves the parent's side and arrives at the child's side,
// bowing outward, so it reads as another way in rather than a second tree.
function reentrantPath(s, t, opt) {
  const leftward = t.x < s.x;
  const dir = leftward ? -1 : 1;
  const x1 = s.x + (dir * s.width) / 2;
  const y1 = s.y + s.height / 2;
  const x2 = t.x - (dir * t.width) / 2;
  const y2 = t.y + t.height / 2;
  const bow = dir * Math.max(opt.gap * 2, Math.abs(x2 - x1) / 4);
  return `M ${r(x1)} ${r(y1)} C ${r(x1 + bow)} ${r(y1)}, ${r(x2 - bow)} ${r(y2)}, ${r(x2)} ${r(y2)}`;
}

// A tree edge's label sits just above its child: children of a row never
// overlap, so neither do their labels, however many edges cross the gap.
function labelPoint(s, t, isTree, opt) {
  if (isTree) {
    return { x: t.x, y: t.y - opt.labelLift };
  }
  const leftward = t.x < s.x;
  const dir = leftward ? -1 : 1;
  const x1 = s.x + (dir * s.width) / 2;
  const x2 = t.x - (dir * t.width) / 2;
  return { x: (x1 + x2) / 2, y: (s.y + t.y) / 2 + opt.nodeHeight / 2 };
}

const r = (n) => Math.round(n * 10) / 10;
