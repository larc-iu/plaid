// How the arcs over a sentence stack, and the shape one is drawn in. Shared by
// the two places UD draws a dependency tree: the annotation editor's
// DependencyTree and the assistant's citation card (components/assistant/
// depTree.js). Those two renderers have almost nothing else in common — one
// measures its words off the DOM and owns dragging and label editing, the
// other estimates them from character counts and is read-only in a panel — but
// the geometry below is the part that has to agree, and the part that is easy
// to get subtly wrong.
//
// An arc's height used to be a function of its own width alone, through a
// logistic that flattened out: every arc spanning more than about twenty words
// was drawn at the same ceiling height, so the long arcs of a sentence were
// laid on top of one another and crossed. Height is now a function of what an
// arc encloses: an arc sits one step above the tallest arc nested inside it.
//
// That alone is not enough, and this is the trap. Any arc that rises in
// proportion to its own span — a half-ellipse, or a cubic with its control
// points at the apex — climbs like `h * sqrt(x / span)` near its endpoint. So
// a WIDER arc, taller though it is, sits LOWER than the narrow arcs nested
// under it for the first stretch after a shared endpoint, and cuts through
// every one of them. The flat-topped shape below is what fixes that: it rises
// vertically through a corner of the SAME width whatever the span, so a taller
// arc is higher along its whole length. Together, the two draw a projective
// tree without a single crossing. (Arcs that cross because their endpoints
// interleave — a non-projective tree — still cross. Nothing drawn this way can
// help that, but they now cross at different heights.)

// The apex of an arc that encloses nothing, and what each enclosed level adds.
// The step is a deprel label (11px, drawn just above its own arc) plus a few
// pixels: enough that a label never touches the arc above it, and no more —
// the stack over a long sentence is deep, and air between the levels is
// height the whole page pays for.
export const ARC_BASE = 22;
export const ARC_STEP = 19;

// Where an arc turns out of its rise into its horizontal run. The same for
// every arc in one tree, which is what the note above is about. A tree drawn
// at a smaller scale passes its own (see `arcPath`), but it must pass ONE.
export const ARC_CORNER = 18;

// What the arc band shares the tree SVG with: the ROOT bar and the tallest
// arc's label above it, the arrowheads and the words below.
const BAND_MARGIN = 110;
const MIN_TREE_HEIGHT = 150;

// How far the tree overlay hangs ABOVE the sentence grid it is drawn over,
// and how far the words sit above the bottom of that overlay. Both are here
// because four places need them to agree: the overlay's own offset, the
// measured y of a word (useTokenPositions), the baseline the arcs are drawn
// from (DependencyTree), and the grid padding below. Move one alone and the
// arrowheads leave the words.
export const TREE_OVERHANG = 50;
export const TOKEN_BASELINE = 30;

// The grid padding that reserves the difference: the overhang, the words'
// own baseline inside the overlay, and a few pixels of air under the
// arrowheads.
const GRID_INSET = TREE_OVERHANG + TOKEN_BASELINE + 5;

// How high above the words an arc at this level runs.
export const arcHeight = (level, { base = ARC_BASE, step = ARC_STEP } = {}) =>
  base + (Math.max(1, level) - 1) * step;

// Which level each arc is drawn at, given where each one begins and ends in
// word order: `[{ id, left, right }]`, left <= right. Ids come back in a Map.
export const assignLevels = (spans) => {
  // Narrowest first, so every arc nested inside this one already has a level.
  const sorted = [...spans].sort(
    (p, q) => p.right - p.left - (q.right - q.left) || p.left - q.left,
  );

  const levels = new Map();
  const placed = [];
  let maxLevel = 0;
  for (const span of sorted) {
    let level = 1;
    for (const other of placed) {
      // Two arcs share a level only when they stand side by side. Meeting at a
      // single word is side by side; having any word between them is not, and
      // that covers both a nested arc and one that crosses this one.
      if (Math.max(other.left, span.left) < Math.min(other.right, span.right)) {
        level = Math.max(level, other.level + 1);
      }
    }
    placed.push({ ...span, level });
    levels.set(span.id, level);
    if (level > maxLevel) maxLevel = level;
  }
  return { levels, maxLevel };
};

// One arc: up out of the head, a quarter turn into a horizontal run at its own
// height, and a quarter turn back down onto the word it points at. The flat run
// is where the deprel label sits. `baselineY` is the line the arcs spring from
// and y grows downward, so the arc rises to `baselineY - height`.
export const arcPath = (fromX, toX, baselineY, height, corner = ARC_CORNER) => {
  const apexY = baselineY - height;
  const direction = toX > fromX ? 1 : -1;
  const turn = Math.min(corner, Math.abs(toX - fromX) / 2);
  const riseEnd = fromX + direction * turn;
  const fallStart = toX - direction * turn;
  return `M ${fromX} ${baselineY} Q ${fromX} ${apexY} ${riseEnd} ${apexY} L ${fallStart} ${apexY} Q ${toX} ${apexY} ${toX} ${baselineY}`;
};

// An arc still in the hand: the same rise and flat run as `arcPath`, ending at
// the pointer and not at a word. It climbs to the innermost level, or to the
// pointer when that is further out, so it is already the shape it will be when
// it lands and only its last stretch follows the hand. `down` is the band
// under the words, where an arc drops out of its word instead of rising.
export const handArcPath = (
  fromX,
  baselineY,
  toX,
  toY,
  { corner = ARC_CORNER, down = false } = {},
) => {
  const apexY = down ? Math.max(baselineY + ARC_BASE, toY) : Math.min(baselineY - ARC_BASE, toY);
  const direction = toX >= fromX ? 1 : -1;
  const turn = Math.min(corner, Math.abs(toX - fromX) / 2);
  return `M ${fromX} ${baselineY} Q ${fromX} ${apexY} ${fromX + direction * turn} ${apexY} L ${toX - direction * turn} ${apexY} Q ${toX} ${apexY} ${toX} ${toY}`;
};

// The level an arc would be drawn at if it were added to these: the stacking
// run with the candidate in it, so the preview of an arc over a word sits
// exactly where the arc will. `spans` are `{ id, left, right }` in word order.
export const levelAmong = (spans, left, right) => {
  const id = Symbol('candidate');
  return assignLevels([...spans, { id, left, right }]).levels.get(id);
};

// The column each relation endpoint names. Relations point at lemma spans, and
// a token stands in for its own span, which is the same pair of ids the
// annotation editor's tree resolves a position by.
export const buildIndexById = (tokens, lemmaSpans) => {
  const indexById = new Map();
  tokens.forEach((token, index) => {
    if (!token?.id) return;
    if (!indexById.has(token.id)) indexById.set(token.id, index);
    const span = lemmaSpans?.find(
      (s) => (s.tokens && s.tokens.includes(token.id)) || s.begin === token.id,
    );
    // A multi-word token's span resolves to its leftmost column, as the tree's
    // own position lookup does.
    if (span?.id && !indexById.has(span.id)) indexById.set(span.id, index);
  });
  return indexById;
};

// The annotation editor's whole layout: levels, and the two heights that follow
// from the deepest stack. A relation whose endpoints aren't on screen yet (a
// rebuild in flight) is simply absent from `levels`; the tree draws it at the
// innermost level.
export const computeArcLayout = (relations, indexById) => {
  const spans = [];
  for (const relation of relations || []) {
    // A root relation points a token at itself and is drawn as a drop from the
    // ROOT bar, not as an arc, so it takes no room in the stack.
    if (relation.source === relation.target) continue;
    const a = indexById.get(relation.source);
    const b = indexById.get(relation.target);
    if (a === undefined || b === undefined) continue;
    spans.push({ id: relation.id, left: Math.min(a, b), right: Math.max(a, b) });
  }

  const { levels, maxLevel } = assignLevels(spans);
  const bandHeight = maxLevel > 0 ? arcHeight(maxLevel) : 0;
  const treeHeight = Math.max(MIN_TREE_HEIGHT, bandHeight + BAND_MARGIN);
  return { levels, maxLevel, treeHeight, gridPaddingTop: treeHeight - GRID_INSET };
};

// The band BELOW the words, where the enhanced graph's extra edges hang. The
// same stacking as above, turned over: an arc drops out of its head, runs
// flat, and comes back up into the word it points at, and its label sits under
// its own run. `arcPath` draws it given a NEGATIVE height.
//
// A sentence with no extra edges has no band, so the words sit on their
// annotation rows exactly as they do in a project that never draws one.
export const LOWER_BAND_TOP = 6; // the arrowheads, between the word and its arcs
const LOWER_LABEL = 14; // the deepest run's label, under it
const LOWER_MARGIN = 6;

export const computeLowerBand = (relations, indexById) => {
  if (!relations || relations.length === 0) return { levels: new Map(), bandHeight: 0 };
  const spans = [];
  let hasRoot = false;
  for (const relation of relations) {
    // A root of the enhanced graph alone is a stub under its word, one level
    // deep, and takes no room in the stack.
    if (relation.source === relation.target) {
      hasRoot = true;
      continue;
    }
    const a = indexById.get(relation.source);
    const b = indexById.get(relation.target);
    if (a === undefined || b === undefined) continue;
    spans.push({ id: relation.id, left: Math.min(a, b), right: Math.max(a, b) });
  }
  const { levels, maxLevel } = assignLevels(spans);
  const deepest = Math.max(maxLevel > 0 ? arcHeight(maxLevel) : 0, hasRoot ? ARC_BASE : 0);
  // Every relation here may be one whose words are not on screen yet (a
  // rebuild in flight): the band still holds a level for it to be drawn at.
  const depth = deepest || ARC_BASE;
  return { levels, bandHeight: LOWER_BAND_TOP + depth + LOWER_LABEL + LOWER_MARGIN };
};

// ---------------------------------------------------------------------------
// The annotation editor's own geometry. Everything below answers "where does
// this go", given measured word positions and nothing else: no React, no DOM,
// no vocabulary. It lived inline in DependencyTree.jsx, where the numbers in
// it could only be checked by looking at the screen, and where each one the
// band of enhanced edges below the words also needed was written a second
// time in EnhancedArcs.jsx.
//
// A "position" here is one measured word: `{ x, y, width, height, index }`
// (see the editor's useTokenPositions). A "frame" is the tree's own vertical
// layout for one sentence, from `treeFrame`.
// ---------------------------------------------------------------------------

// The ROOT bar across the top of the overlay, in the overlay's coordinates.
export const ROOT_Y = 25;
export const ROOT_BAR_HEIGHT = 20;
// Where a root's straight drop springs from: the bar's own midline.
export const ROOT_LINE = ROOT_Y + ROOT_BAR_HEIGHT / 2;
// How far down the bar a release still counts as a release ON the bar. Past
// its midline, so letting go just under the line the arc is drawn from still
// makes a root, and short of its bottom edge, where the words' own column
// reach begins.
export const ROOT_GRAB = ROOT_Y + 15;

// The room between the line the arcs spring from and the words themselves:
// what the arrowheads are drawn in.
const ARROW_ROOM = 10;

// An arc leaves its head this far along, so its rise does not sit on top of an
// arrowhead pointing at that same word.
const HEAD_OFFSET = 5;

// A deprel label rides this far above its own arc's flat run, and this far
// below one in the band under the words (where it hangs beneath the run, so it
// clears the glyphs' own height as well).
const LABEL_LIFT = 5;
const LABEL_DROP = 11;

// The inline editor's 22px input, lifted so that it straddles the label it
// replaces instead of sitting under it. The label's glyphs run from about 8px
// above their baseline to about 2px below it, so their middle is ~3px up, and
// the middle of a 22px box on that is 14px up. The tree passed 12 and the band
// 14; this is the one they now share.
export const LABEL_EDITOR_LIFT = 14;
export const LABEL_EDITOR_WIDTH = 100;
export const LABEL_EDITOR_HEIGHT = 26;

// Room to the right of the last word, so the rightmost arc and arrowhead are
// not clipped by the SVG's own edge. Not TREE_OVERHANG, which happens to be
// the same number and means something else entirely.
const RIGHT_MARGIN = 50;
const MIN_SVG_WIDTH = 300;

// How far either side of a word's centre the hand still counts as being on
// that word. ONE rule, because the invisible grab rect and the column a drag
// snaps by are the same reach seen twice: 37d25898 gave short words a floor so
// they could be snapped to, and the rect kept the bare proportion, which left
// a two-letter word snappable from further away than it was clickable. The
// default width is for a position measured before its word was.
const WORD_WIDTH_FALLBACK = 60;
export const reachOf = (position) => Math.max((position?.width || WORD_WIDTH_FALLBACK) * 0.6, 24);

// The invisible rect over a word that takes its clicks and starts its drags.
// As wide as the word's reach either side, and tall enough to cover the word
// and a little air over it.
const GRAB_HEIGHT = 36;
export const grabRect = (position) => {
  const reach = reachOf(position);
  return {
    x: position.x - reach,
    y: position.y - GRAB_HEIGHT * 0.5 + ARROW_ROOM,
    width: reach * 2,
    height: GRAB_HEIGHT,
  };
};

// The tree's vertical frame for one sentence: where the words sit inside the
// overlay, and the line every arc springs from and lands on. One y for all of
// them, whatever a word's own box does.
export const treeFrame = (treeHeight) => {
  const tokenY = treeHeight - TOKEN_BASELINE;
  return { tokenY, baselineY: tokenY - ARROW_ROOM };
};

// How wide the overlay has to be to hold these words: the rightmost one plus
// room for its arc. The tree and the band under it are drawn over the same
// grid and take the same width.
export const svgWidth = (positions) =>
  positions.length > 0 ? Math.max(...positions.map((p) => p.x)) + RIGHT_MARGIN : MIN_SVG_WIDTH;

// The arrowhead: a small triangle with its tip at `tipY`, pointing down onto a
// word from the tree above, or up into one from the band below. Written out
// four times before this.
const ARROW_HALF_WIDTH = 3;
const ARROW_LENGTH = 5;
// How far past the baseline the tree's arrowheads reach, so a tip touches its
// word rather than stopping short of it.
const ARROW_OVERSHOOT = 2;
export const arrowPoints = (x, tipY, { up = false } = {}) => {
  const baseY = up ? tipY + ARROW_LENGTH : tipY - ARROW_LENGTH;
  return `${x - ARROW_HALF_WIDTH},${baseY} ${x + ARROW_HALF_WIDTH},${baseY} ${x},${tipY}`;
};

// The word an arc in the hand would land on: the one whose COLUMN the pointer
// is in, on the arc's own side of the words. For the tree that is from under
// the ROOT bar down to the word, for the enhanced graph from the word down as
// far as the hand goes. One rule for both, so an arc snaps to a word as
// readily above it as below: when the tree asked for the word's small grab box
// while the band below took the whole column, drawing above was noticeably the
// fussier of the two. The nearest word wins where two short ones' reach
// overlaps.
export const wordInColumn = (positions, point, { below = false, frame }) => {
  if (!point) return null;
  const inBand = below
    ? point.y >= frame.tokenY - 12
    : point.y >= ROOT_Y + ROOT_BAR_HEIGHT && point.y <= frame.tokenY + 28;
  if (!inBand) return null;
  let best = null;
  for (const p of positions) {
    const dx = Math.abs(point.x - p.x);
    if (dx > reachOf(p)) continue;
    if (!best || dx < best.dx) best = { p, dx };
  }
  return best?.p || null;
};

// One arc of the tree, over the words: its path, its arrowhead and where its
// label sits. A root is not an arc but a straight drop from the ROOT bar onto
// its own word, and its label rides halfway down that drop.
export const treeArc = ({ fromX, toX, toRoot = false, height, frame }) => {
  const { baselineY, tokenY } = frame;
  if (toRoot) {
    return {
      d: `M ${fromX} ${baselineY} L ${fromX} ${ROOT_LINE}`,
      arrow: arrowPoints(fromX, baselineY + ARROW_OVERSHOOT),
      label: { x: fromX, y: (tokenY + ROOT_Y) / 2 },
    };
  }
  const offset = toX > fromX ? HEAD_OFFSET : -HEAD_OFFSET;
  return {
    d: arcPath(fromX + offset, toX, baselineY, height),
    arrow: arrowPoints(toX, baselineY + ARROW_OVERSHOOT),
    label: { x: (fromX + toX) / 2, y: baselineY - height - LABEL_LIFT },
  };
};

// One arc of the band BELOW the words: the same three answers, turned over.
// The arc drops out of its head, runs flat and comes back up into the word it
// points at, its arrowhead points up, and its label hangs under its own run.
// `baseline` is the line it hangs from: the band's own top for a drawn arc,
// and the measured underside of a word for one still in the hand.
export const bandArc = ({ fromX, toX, toRoot = false, height, baseline = LOWER_BAND_TOP }) => {
  const label = { x: toRoot ? fromX : (fromX + toX) / 2, y: baseline + height + LABEL_DROP };
  if (toRoot) {
    return {
      d: `M ${fromX} ${baseline} l 0 ${height}`,
      arrow: arrowPoints(fromX, baseline - ARROW_LENGTH, { up: true }),
      label,
    };
  }
  const offset = toX > fromX ? HEAD_OFFSET : -HEAD_OFFSET;
  return {
    d: arcPath(fromX + offset, toX, baseline, -height),
    arrow: arrowPoints(toX, baseline - ARROW_LENGTH, { up: true }),
    label,
  };
};

// The band's baseline under one word: its own measured underside, plus the
// room the arrowheads pointing up into it need. A word not measured yet has no
// underside, so the band hangs from the bottom of the overlay instead.
export const bandBaselineUnder = (position, treeHeight) =>
  position ? position.y + (position.height || 0) / 2 + LOWER_BAND_TOP : treeHeight;

// Where the band of enhanced edges hangs, in the sentence block's own
// coordinates: the measured underside of the first word. The tree overlay's
// coordinates start TREE_OVERHANG above that block, which is the whole of the
// difference between this and `bandBaselineUnder` — the two answer the same
// question from the two boxes, so `bandTop(w) + TREE_OVERHANG + LOWER_BAND_TOP`
// is `bandBaselineUnder(w)`.
export const bandTop = (position) => position.y + (position.height || 0) / 2 - TREE_OVERHANG;

// Where a relation's label sits along the sentence, which is the order the
// labels are walked in. `xOf` answers a relation endpoint's x.
export const labelXOf = (relation, xOf) =>
  relation.source === relation.target
    ? xOf(relation.source) || 0
    : ((xOf(relation.source) || 0) + (xOf(relation.target) || 0)) / 2;

// The tree's labels and the band's, left to right across the sentence.
export const sortByLabelX = (relations, xOf) =>
  [...relations].sort((a, b) => labelXOf(a, xOf) - labelXOf(b, xOf));

// The arc in the hand, drawn as close to the arc it will become as can be
// known, and on ONE side of the words for the whole drag: above for the tree,
// below for the enhanced graph, as the drag began. Over a word it IS the arc
// to come — `treeArc`/`bandArc` at the level the stacking will give it — so
// nothing jumps when it lands. Between words it is the same shape, ending at
// the pointer.
//
//   from     the word the drag left, or null when it left the ROOT bar
//   to       the word the pointer is on, or null
//   pointer  where the hand is, in the overlay's coordinates
//   below    the enhanced graph's side, under the words
//   toRoot   the pointer is on the ROOT bar (only when the drag left a word)
//   spans    the arcs this one will stack among, `{ id, left, right }`
//   under    (word) => the band's baseline beneath it; read only when `below`
//
// A `label` comes back exactly when the arc has a word at both ends and so a
// label to wear; the caller draws the rest grey.
export const dragPreview = ({
  from,
  to,
  pointer,
  below = false,
  toRoot = false,
  spans = [],
  frame,
  under,
}) => {
  const fromRoot = !from;

  // A root. In the tree, the straight drop from the ROOT bar onto its word; in
  // the enhanced graph, the stub under it.
  if ((fromRoot && to) || toRoot) {
    const word = fromRoot ? to : from;
    if (below)
      return bandArc({ fromX: word.x, toRoot: true, height: ARC_BASE, baseline: under(word) });
    return treeArc({ fromX: word.x, toRoot: true, frame });
  }

  // Out of the ROOT bar and over no word yet. The bar is above the words
  // whichever graph this is for, so this one stretch is drawn from it.
  if (fromRoot) {
    const tipY = Math.max(pointer.y, ROOT_GRAB);
    return {
      d: `M ${pointer.x} ${ROOT_LINE} L ${pointer.x} ${tipY}`,
      arrow: arrowPoints(pointer.x, tipY),
      label: null,
    };
  }

  // Between words. The end follows the hand, but never across the row of
  // words: an arc for the tree stays above it and one for the enhanced graph
  // below it, wherever the pointer goes.
  if (!to) {
    if (below) {
      const base = under(from);
      const tipY = Math.max(pointer.y, base);
      return {
        d: handArcPath(from.x, base, pointer.x, tipY, { down: true }),
        arrow: arrowPoints(pointer.x, tipY - ARROW_LENGTH, { up: true }),
        label: null,
      };
    }
    const tipY = Math.min(pointer.y, frame.baselineY);
    return {
      d: handArcPath(from.x, frame.baselineY, pointer.x, tipY),
      arrow: arrowPoints(pointer.x, tipY + ARROW_OVERSHOOT),
      label: null,
    };
  }

  // Over a word. The level comes from the real stacking: every arc that will
  // still be there, plus this one.
  const height = arcHeight(
    levelAmong(spans, Math.min(from.index, to.index), Math.max(from.index, to.index)),
  );
  if (below) return bandArc({ fromX: from.x, toX: to.x, height, baseline: under(to) });
  return treeArc({ fromX: from.x, toX: to.x, height, frame });
};
