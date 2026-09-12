// Where each dependency arc sits in the stack of arcs over a sentence.
//
// An arc's height used to be a function of its own width alone, through a
// logistic that flattened out: every arc spanning more than about twenty words
// was drawn at the same ceiling height, so the long arcs of a sentence were
// laid on top of one another and crossed. Height is now a function of what an
// arc encloses — an arc sits one step above the tallest arc nested inside it —
// which, together with the flat-topped arc shape in DependencyTree, draws a
// projective tree without a single crossing.

// The apex of an arc that encloses nothing, and what each enclosed level adds.
// The step is a deprel label (11px, drawn just above its own arc) plus a few
// pixels: enough that a label never touches the arc above it, and no more —
// the stack over a long sentence is deep, and air between the levels is
// height the whole page pays for.
export const ARC_BASE = 22;
export const ARC_STEP = 19;

// What the arc band shares the tree SVG with: the ROOT bar and the tallest
// arc's label above it, the arrowheads and the words below.
const BAND_MARGIN = 110;
const MIN_TREE_HEIGHT = 150;

// The tree is an overlay that starts 50px above the sentence grid (see
// .dependency-tree-container); the words in the grid sit just below the
// arrowheads. This is the grid padding that reserves the difference.
const GRID_INSET = 85;

// How high above the words an arc at this level runs.
export const arcHeight = (level) => ARC_BASE + (Math.max(1, level) - 1) * ARC_STEP;

// The column each relation endpoint names. Relations point at lemma spans, and
// a token stands in for its own span, which is the same pair of ids the tree
// resolves a position by.
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

// Levels, tallest-arc height, and the two heights that follow from it. A
// relation whose endpoints aren't on screen yet (a rebuild in flight) is simply
// absent from `levels`; the tree draws it at the innermost level.
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

  // Narrowest first, so every arc nested inside this one already has a level.
  spans.sort((p, q) => p.right - p.left - (q.right - q.left) || p.left - q.left);

  const levels = new Map();
  const placed = [];
  let maxLevel = 0;
  for (const span of spans) {
    let level = 1;
    for (const other of placed) {
      // Two arcs share a level only when they stand side by side. Meeting at a
      // single word is side by side; having any word between them is not, and
      // that covers both a nested arc and one that crosses this one.
      if (Math.max(other.left, span.left) < Math.min(other.right, span.right)) {
        level = Math.max(level, other.level + 1);
      }
    }
    span.level = level;
    placed.push(span);
    levels.set(span.id, level);
    if (level > maxLevel) maxLevel = level;
  }

  const bandHeight = maxLevel > 0 ? arcHeight(maxLevel) : 0;
  const treeHeight = Math.max(MIN_TREE_HEIGHT, bandHeight + BAND_MARGIN);
  return { levels, maxLevel, treeHeight, gridPaddingTop: treeHeight - GRID_INSET };
};
