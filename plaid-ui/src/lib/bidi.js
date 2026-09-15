// Arrow keys in a grid that may run either way.
//
// Two directions are in play in one keystroke and they are not the same one.
//
// The GRID's direction decides which NEIGHBOUR a key means. In an RTL sentence
// the next word is the one further left, so ArrowLeft moves forwards through
// the sentence and ArrowRight moves back.
//
// The CELL's own direction decides where its TEXT edges are, and a cell is on
// `dir="auto"`, so it resolves on its own content. An English gloss standing in
// a column under an Arabic word is an LTR box: its logical end is still on its
// right, and ArrowRight there has to move the caret through "book" before it
// leaves the cell.
//
// Getting only the first of the two right is worse than doing nothing: the key
// that should walk the caret through a value jumps out of it instead.

/**
 * Is this element laid out right to left? Reads the RESOLVED direction, so a
 * field on `dir="auto"` answers for the value it is actually holding.
 *
 * False wherever the question cannot be asked (no layout engine, a detached
 * node), which leaves every caller on its left-to-right path.
 */
export const isRtlBox = (el) => {
  try {
    return globalThis.getComputedStyle?.(el)?.direction === 'rtl';
  } catch {
    return false;
  }
};

/**
 * Is the caret at the edge this arrow key presses TOWARDS, so the key should
 * leave the field rather than move inside it?
 *
 * A collapsed caret only: a selection collapses first, so editing text is never
 * hijacked. An empty field is at both its edges and always qualifies.
 */
export const caretAtArrowEdge = (el, visualRight) => {
  const start = el?.selectionStart ?? 0;
  const end = el?.selectionEnd ?? 0;
  if (start !== end) return false;
  const towardLogicalEnd = isRtlBox(el) ? !visualRight : visualRight;
  return towardLogicalEnd ? end === (el?.value ?? '').length : start === 0;
};

/**
 * Which way along the reading order an arrow key steps, given how the grid
 * around it is laid out: 1 forwards, -1 back.
 */
export const arrowStep = (visualRight, gridRtl) => (visualRight === !!gridRtl ? -1 : 1);
