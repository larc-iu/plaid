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

/**
 * How far the canvas has scrolled from the left of the STAGE, whose axis is
 * physical in either script (canvas.css). The document constants are pinned
 * in a sticky margin at the canvas's visible left edge, and this is where a
 * line drawn to one has to end.
 *
 * In a right-to-left scroller `scrollLeft` is 0 at the RIGHT edge and runs
 * negative leftwards, and the canvas opens at that edge, so reading it as a
 * distance from the left put every one of those lines a whole overflow width
 * out -- off screen -- from the first paint on.
 *
 * @param box  the scroller, or anything with its three measurements
 * @param direction  'rtl' or 'ltr'
 */
export const stageLeftOffset = ({ scrollLeft = 0, scrollWidth = 0, clientWidth = 0 }, direction) =>
  direction === 'rtl' ? Math.max(0, scrollWidth - clientWidth) + scrollLeft : scrollLeft;

export const DEFAULT_OPTIONS = Object.freeze({
  // The room between the bottom of a row's tallest node and the top of the
  // next row: the lanes, and the labels floating over the children. Rows are
  // as tall as their OWN tallest node: one node with five tags used to make
  // every row of its sentence that tall.
  edgeRoom: 66,
  nodeHeight: 36,
  gap: 12,
  marginTop: 16,
  // Below the last row: room for a re-entrant edge dipping under it.
  marginBottom: 32,
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
  // A relation pill's box, estimated, for keeping labels off nodes and off
  // each other: monospace at 0.72rem, 6px of padding a side.
  pillWidth: (text) => 14 + 7 * String(text || '').length,
  pillHeight: 20,
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
function treeOf(sentence, nodesById) {
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
 * @returns {{ nodes: Map<nodeId, {x, y, width, height, row}>, edges: Array, height: number, left: number, right: number, rows: number, tree: object }}
 *   `left` and `right` are the extent of what is drawn: `left` is 0 or less.
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

  // Each row's top: the rows above it, each as tall as its own tallest node,
  // with the edge room under it.
  const depths = [...rows.keys()].sort((a, b) => a - b);
  const tallest = new Map();
  depths.forEach((depth) => {
    tallest.set(depth, Math.max(...rows.get(depth).map((id) => sizeOf(nodesById.get(id)).height)));
  });
  const rowTop = new Map();
  let top = opt.marginTop;
  depths.forEach((depth) => {
    rowTop.set(depth, top);
    top += tallest.get(depth) + opt.edgeRoom;
  });

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
        y: rowTop.get(depth),
        width: size.width,
        height: size.height,
        row: depth,
      });
    });
  });

  // Where the row gaps are: below the tallest node of each row, above the
  // labels floating over the next row's nodes.
  const gapOf = (row) => ({
    top: rowTop.get(row) + tallest.get(row),
    bottom: (rowTop.get(row + 1) ?? top) - opt.labelLift - opt.labelHeight,
  });

  const placed = sentence.edges.filter((e) => nodes.has(e.source) && nodes.has(e.target));
  const lanes = assignLanes(placed, nodes, tree, gapOf, opt);

  const edges = placed.map((edge) => {
    const s = nodes.get(edge.source);
    const t = nodes.get(edge.target);
    const isTree = tree.treeEdgeIds.has(edge.id);
    if (isTree) {
      return {
        id: edge.id,
        source: edge.source,
        target: edge.target,
        role: edge.role,
        tree: true,
        path: treePath(s, t, lanes.get(edge.id), opt),
        label: { x: t.x, y: t.y - opt.labelLift },
      };
    }
    const curve = routeBetween(s, t, nodes, opt, [edge.source, edge.target]);
    return {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      role: edge.role,
      tree: false,
      path: curvePath(curve),
      curve,
      label: null,
    };
  });
  placeLabels(edges, nodes, opt);

  // As tall as the rows, and as whatever dips below the last of them. As wide
  // as the boxes, and as whatever bows out past them: left of the graph is the
  // margin, where the constants are, so the stage makes room for it.
  let bottom = top - opt.edgeRoom + opt.marginBottom;
  let left = 0;
  let right = 0;
  nodes.forEach((p) => {
    left = Math.min(left, p.x - p.width / 2);
    right = Math.max(right, p.x + p.width / 2);
  });
  edges.forEach((e) => {
    if (e.tree) return;
    bottom = Math.max(bottom, e.label.y + opt.pillHeight / 2 + 8);
    const half = opt.pillWidth(e.role) / 2;
    left = Math.min(left, e.label.x - half);
    right = Math.max(right, e.label.x + half);
    for (let i = 0; i <= 12; i++) {
      const [x, y] = pointOn(e.curve, i / 12);
      bottom = Math.max(bottom, y + 8);
      left = Math.min(left, x - 8);
      right = Math.max(right, x + 8);
    }
  });
  const height = rowCount ? bottom : opt.marginTop + opt.nodeHeight + opt.marginBottom;

  return { nodes, edges, height, left, right, rows: rowCount, tree };
}

// A tree edge that reaches sideways runs horizontally across its row gap. In
// one gap each PARENT gets a lane, the widest reach nearest the row, and its
// runs share it: one horizontal with a drop to each child. Parents crossing
// the same gap keep apart. A child under its parent needs no lane.
function assignLanes(edges, nodes, tree, gapOf, opt) {
  const byGap = new Map();
  edges.forEach((edge) => {
    if (!tree.treeEdgeIds.has(edge.id)) return;
    const s = nodes.get(edge.source);
    const t = nodes.get(edge.target);
    const reach = Math.abs(t.x - s.x);
    if (underParent(s, t, opt)) return;
    if (!byGap.has(s.row)) byGap.set(s.row, []);
    // Every run of one parent shares a lane: one horizontal, a drop to each
    // child. A lane per run drew a node with five far children as a ribbon.
    byGap.get(s.row).push({ id: edge.id, reach, key: edge.source });
  });
  const lanes = new Map();
  byGap.forEach((list, row) => {
    const { top, bottom } = gapOf(row);
    const first = top + opt.laneInset;
    const last = Math.max(first, bottom - opt.laneInset);
    // The widest reach of each key decides its place, nearest the row.
    const reachOf = new Map();
    list.forEach((item) => reachOf.set(item.key, Math.max(reachOf.get(item.key) || 0, item.reach)));
    const keys = [...reachOf.keys()].sort((a, b) => reachOf.get(b) - reachOf.get(a));
    const step = keys.length > 1 ? Math.min(opt.laneStep, (last - first) / (keys.length - 1)) : 0;
    const laneOf = new Map(keys.map((key, i) => [key, first + i * step]));
    list.forEach((item) => lanes.set(item.id, laneOf.get(item.key)));
  });
  return lanes;
}

// Whether a child's middle lies under its parent's box, with room for the
// corner: then its edge drops straight from the parent's bottom edge.
const underParent = (s, t, opt) => Math.abs(t.x - s.x) <= s.width / 2 - opt.cornerRadius;

// The parent's bottom edge to the top center of the child. Straight down from
// right above the child when it lies under the parent: a line from the
// parent's middle to a child a few pixels aside was drawn slanted, and read
// as a mistake beside the square lines around it. Otherwise down to the
// edge's lane, across, and down again, with rounded corners.
function treePath(s, t, lane, opt) {
  const x1 = s.x;
  const y1 = s.y + s.height;
  const x2 = t.x;
  const y2 = t.y;
  if (underParent(s, t, opt) || lane == null) {
    return `M ${r(x2)} ${r(y1)} L ${r(x2)} ${r(y2)}`;
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

// A curve between two nodes that are not parent and child in the tree: a
// re-entrant edge, or a document relation of the focused node. Several shapes
// are tried and the one crossing the fewest other boxes is taken, the first
// of those listed when they tie, so a clear path stays as it always was.
//
// Two nodes in ONE row: a dip under the row, out of the bottom of one and up
// into the bottom of the other, deeper than every node between them. A
// sideways bow between two neighbours looped into both boxes.
//
// Rows apart: out of the side of the source and into the same side of the
// target, bulging out from that side. A side-to-side bow cut straight through
// both boxes when they were nearly above one another, which is what a
// reflexive draws (one node as two arguments of the node above it). Then the
// other side, then wider bows.
//
// `exclude` are the ids whose boxes the curve may touch (its own ends).
// Returns the four points of one cubic.
export function routeBetween(s, t, nodes, opt = DEFAULT_OPTIONS, exclude = []) {
  const o = { ...DEFAULT_OPTIONS, ...opt };
  const others = [...nodes.entries()]
    .filter(([id]) => !exclude.includes(id))
    .map(([, p]) => p)
    .filter((p) => p !== s && p !== t);
  const candidates = s.row === t.row ? dips(s, t, others) : bulges(s, t, o);
  let best = null;
  candidates.forEach((curve, order) => {
    const hits = crossings(curve, others);
    if (!best || hits < best.hits) best = { curve, hits, order };
  });
  return best.curve;
}

function dips(s, t, others) {
  const dir = t.x < s.x ? -1 : 1;
  const lo = Math.min(s.x, t.x);
  const hi = Math.max(s.x, t.x);
  // The deepest box in the way, of the same row and between the two.
  let floor = Math.max(s.y + s.height, t.y + t.height);
  others.forEach((p) => {
    if (p.row === s.row && p.x > lo && p.x < hi) floor = Math.max(floor, p.y + p.height);
  });
  const x1 = s.x + (dir * s.width) / 4;
  const y1 = s.y + s.height;
  const x2 = t.x - (dir * t.width) / 4;
  const y2 = t.y + t.height;
  // A cubic with both handles at one depth reaches three quarters of it.
  return [16, 28, 42].map((depth) => {
    const low = floor + depth;
    const handle = (y) => y + ((low - y) * 4) / 3;
    return [
      [x1, y1],
      [x1, handle(y1)],
      [x2, handle(y2)],
      [x2, y2],
    ];
  });
}

function bulges(s, t, o) {
  const down = t.y > s.y;
  const toward = t.x < s.x ? -1 : 1;
  const out = [];
  [toward, -toward].forEach((side) =>
    [1, 1.6, 2.4].forEach((wide) => {
      const x1 = s.x + (side * s.width) / 2;
      const y1 = down ? s.y + s.height : s.y;
      const x2 = t.x + (side * t.width) / 2;
      const y2 = down ? t.y : t.y + t.height;
      const bow = side * Math.max(o.gap * 3, Math.abs(t.y - s.y) / 3) * wide;
      const lead = (y2 - y1) / 4;
      out.push([
        [x1, y1],
        [x1 + bow, y1 + lead],
        [x2 + bow, y2 - lead],
        [x2, y2],
      ]);
    }),
  );
  return out;
}

/** A point on a cubic, at `u` from 0 to 1. */
export const pointOn = ([p0, p1, p2, p3], u) => {
  const v = 1 - u;
  const a = v * v * v;
  const b = 3 * v * v * u;
  const c = 3 * v * u * u;
  const d = u * u * u;
  return [
    a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0],
    a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1],
  ];
};

// How many of 24 points along the curve fall inside another box.
function crossings(curve, boxes) {
  let hits = 0;
  for (let i = 1; i < 24; i++) {
    const [x, y] = pointOn(curve, i / 24);
    if (boxes.some((p) => inside(x, y, p, 3))) hits++;
  }
  return hits;
}

const inside = (x, y, p, pad = 0) =>
  x > p.x - p.width / 2 - pad &&
  x < p.x + p.width / 2 + pad &&
  y > p.y - pad &&
  y < p.y + p.height + pad;

/** A cubic's points as an SVG path, shifted by `dx`. */
export const curvePath = ([p0, p1, p2, p3], dx = 0) =>
  `M ${r(p0[0] + dx)} ${r(p0[1])} C ${r(p1[0] + dx)} ${r(p1[1])}, ` +
  `${r(p2[0] + dx)} ${r(p2[1])}, ${r(p3[0] + dx)} ${r(p3[1])}`;

// Every re-entrant edge's label, somewhere along its own curve where it
// covers no node and no other label: the middle first, then further out
// each way. A label on a box hid the variable or concept under it, and one on
// a tree label hid the relation that label names. Where nothing along the
// curve is free, the spot covering the least wins.
function placeLabels(edges, nodes, o) {
  const boxes = [...nodes.values()].map((p) => ({
    left: p.x - p.width / 2 - 2,
    right: p.x + p.width / 2 + 2,
    top: p.y - 2,
    bottom: p.y + p.height + 2,
  }));
  const pill = (x, y, text) => {
    const w = o.pillWidth(text);
    return {
      left: x - w / 2,
      right: x + w / 2,
      top: y - o.pillHeight / 2,
      bottom: y + o.pillHeight / 2,
    };
  };
  const taken = edges.filter((e) => e.tree).map((e) => pill(e.label.x, e.label.y, e.role));
  const overlap = (a, b) =>
    Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) *
    Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
  // Along the curve first. Only when nowhere along it is free, just off it,
  // above or below: still beside its own line, and readable.
  const along = [0.5, 0.42, 0.58, 0.34, 0.66, 0.26, 0.74, 0.18, 0.82];
  const spots = [
    ...along.map((u) => [u, 0]),
    ...along.flatMap((u) => [
      [u, -(o.pillHeight + 2)],
      [u, o.pillHeight + 2],
    ]),
  ];
  edges.forEach((e) => {
    if (e.tree) return;
    let best = null;
    for (const [u, dy] of spots) {
      const [x, cy] = pointOn(e.curve, u);
      const y = cy + dy;
      const box = pill(x, y, e.role);
      const cost = [...boxes, ...taken].reduce((sum, b) => sum + overlap(box, b), 0);
      if (!best || cost < best.cost) best = { x, y, box, cost };
      if (cost === 0) break;
    }
    e.label = { x: best.x, y: best.y };
    taken.push(best.box);
  });
}

const r = (n) => Math.round(n * 10) / 10;
