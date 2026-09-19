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
  // How far above a child its tree edge's label floats, and the label's
  // height, which the row gap keeps clear of lanes.
  // Enough that the pill clears the arrowhead at the child's top edge: the
  // pill is ~20px tall and centred on this, and the head is ~8px long.
  labelLift: 22,
  labelHeight: 12,
  // Lanes: the first sits this far below the row, the next this far apart.
  laneInset: 6,
  laneStep: 9,
  cornerRadius: 8,
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

  // Where the row gaps are: below the tallest node of each row, above the
  // labels floating over the next row's nodes.
  const tallest = new Map();
  nodes.forEach((p) => tallest.set(p.row, Math.max(tallest.get(p.row) || 0, p.height)));
  const gapOf = (row) => {
    const top = opt.marginTop + row * opt.rowHeight + (tallest.get(row) || opt.nodeHeight);
    const bottom = opt.marginTop + (row + 1) * opt.rowHeight - opt.labelLift - opt.labelHeight;
    return { top, bottom };
  };

  const placed = sentence.edges.filter((e) => nodes.has(e.source) && nodes.has(e.target));
  const lanes = assignLanes(placed, nodes, tree, gapOf, opt);

  const edges = placed.map((edge) => {
    const s = nodes.get(edge.source);
    const t = nodes.get(edge.target);
    const isTree = tree.treeEdgeIds.has(edge.id);
    return {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      role: edge.role,
      tree: isTree,
      path: isTree ? treePath(s, t, lanes.get(edge.id), opt) : reentrantPath(s, t, opt),
      label: labelPoint(s, t, isTree, opt),
    };
  });

  return { nodes, edges, height, rows: rowCount, tree };
}

// A tree edge that reaches sideways runs horizontally across its row gap. In
// one gap every such run gets a lane of its own, the longest reach nearest
// the parent, so a parent with many far children fans out into distinct
// lines rather than one band. A short reach needs no lane.
function assignLanes(edges, nodes, tree, gapOf, opt) {
  const byGap = new Map();
  edges.forEach((edge) => {
    if (!tree.treeEdgeIds.has(edge.id)) return;
    const s = nodes.get(edge.source);
    const t = nodes.get(edge.target);
    const reach = Math.abs(t.x - s.x);
    if (reach < 2 * opt.cornerRadius) return;
    if (!byGap.has(s.row)) byGap.set(s.row, []);
    byGap.get(s.row).push({ id: edge.id, reach });
  });
  const lanes = new Map();
  byGap.forEach((list, row) => {
    const { top, bottom } = gapOf(row);
    const first = top + opt.laneInset;
    const last = Math.max(first, bottom - opt.laneInset);
    const step = list.length > 1 ? Math.min(opt.laneStep, (last - first) / (list.length - 1)) : 0;
    list
      .sort((a, b) => b.reach - a.reach)
      .forEach((item, i) => lanes.set(item.id, first + i * step));
  });
  return lanes;
}

// Bottom center of the parent to top center of the child: straight down
// when the child is beneath, otherwise down to the edge's lane, across, and
// down again, with rounded corners.
function treePath(s, t, lane, opt) {
  const x1 = s.x;
  const y1 = s.y + s.height;
  const x2 = t.x;
  const y2 = t.y;
  if (lane == null) {
    return `M ${r(x1)} ${r(y1)} L ${r(x2)} ${r(y2)}`;
  }
  const dir = x2 > x1 ? 1 : -1;
  const rad = Math.min(opt.cornerRadius, Math.abs(x2 - x1) / 2, (lane - y1) / 1, (y2 - lane) / 1);
  return [
    `M ${r(x1)} ${r(y1)}`,
    `L ${r(x1)} ${r(lane - rad)}`,
    `Q ${r(x1)} ${r(lane)}, ${r(x1 + dir * rad)} ${r(lane)}`,
    `L ${r(x2 - dir * rad)} ${r(lane)}`,
    `Q ${r(x2)} ${r(lane)}, ${r(x2)} ${r(lane + rad)}`,
    `L ${r(x2)} ${r(y2)}`,
  ].join(' ');
}

// A re-entrant edge leaves the parent's side and arrives at the child's side,
// bowing outward, so it reads as another way in rather than a second tree.
function reentrantPath(s, t, opt) {
  // Two nodes in one row: a low bow from the side of one to the side of the
  // other, under the labels and over nothing.
  if (sameRow(s, t, opt)) {
    const dir = t.x < s.x ? -1 : 1;
    const x1 = s.x + (dir * s.width) / 2;
    const y1 = s.y + s.height / 2;
    const x2 = t.x - (dir * t.width) / 2;
    const y2 = t.y + t.height / 2;
    const bow = dir * Math.max(opt.gap * 2, Math.abs(x2 - x1) / 4);
    return `M ${r(x1)} ${r(y1)} C ${r(x1 + bow)} ${r(y1)}, ${r(x2 - bow)} ${r(y2)}, ${r(x2)} ${r(y2)}`;
  }
  // Rows apart: leave and arrive on the SAME side, bulging out from it. A
  // side-to-side bow would cut straight through both boxes when the two are
  // nearly above one another, which is exactly the case a reflexive makes
  // (one node as two arguments of the node above it, so a tree edge and a
  // re-entrant edge join the very same pair).
  const { x1, y1, x2, y2, bow } = reentrantEnds(s, t, opt);
  const lead = (y2 - y1) / 4;
  return (
    `M ${r(x1)} ${r(y1)} C ${r(x1 + bow)} ${r(y1 + lead)}, ` +
    `${r(x2 + bow)} ${r(y2 - lead)}, ${r(x2)} ${r(y2)}`
  );
}

const sameRow = (s, t, opt) => Math.abs(t.y - s.y) < opt.rowHeight / 2;

// Where a re-entrant edge between rows leaves, arrives and bulges to: the
// side the target lies toward, at the near corner of each box.
function reentrantEnds(s, t, opt) {
  const down = t.y > s.y;
  const side = t.x < s.x ? -1 : 1;
  return {
    x1: s.x + (side * s.width) / 2,
    y1: down ? s.y + s.height : s.y,
    x2: t.x + (side * t.width) / 2,
    y2: down ? t.y : t.y + t.height,
    bow: side * Math.max(opt.gap * 3, Math.abs(t.y - s.y) / 3),
  };
}

// A tree edge's label sits just above its child: children of a row never
// overlap, so neither do their labels, however many edges cross the gap.
function labelPoint(s, t, isTree, opt) {
  if (isTree) {
    return { x: t.x, y: t.y - opt.labelLift };
  }
  if (sameRow(s, t, opt)) {
    const dir = t.x < s.x ? -1 : 1;
    const x1 = s.x + (dir * s.width) / 2;
    const x2 = t.x - (dir * t.width) / 2;
    return { x: (x1 + x2) / 2, y: (s.y + t.y) / 2 + opt.nodeHeight / 2 };
  }
  // On the bulge, clear of both boxes and of the tree edge to the same node.
  const { x1, y1, x2, y2, bow } = reentrantEnds(s, t, opt);
  return { x: (x1 + x2) / 2 + bow * 0.75, y: (y1 + y2) / 2 };
}

const r = (n) => Math.round(n * 10) / 10;
