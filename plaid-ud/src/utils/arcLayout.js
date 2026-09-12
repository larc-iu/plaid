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

// The tree is an overlay that starts 50px above the sentence grid (see
// .dependency-tree-container); the words in the grid sit just below the
// arrowheads. This is the grid padding that reserves the difference.
const GRID_INSET = 85;

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
