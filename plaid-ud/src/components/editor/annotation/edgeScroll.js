// How far a sentence scrolls sideways in one frame while an arc in the hand is
// held near its edge. Within EDGE pixels of an edge, or past it, the sentence
// scrolls that way, faster the closer the pointer is, up to MAX_STEP a frame.
// Physical left and right, so it reads the same in a right-to-left text:
// scrolling by a positive amount shows more of the right in either direction.

const EDGE = 48;
const MAX_STEP = 16;

/** Pixels to scroll by this frame: negative leftwards, 0 for none. */
export const edgeScrollStep = (x, left, right) => {
  const depth = (into) => Math.ceil((Math.min(into, EDGE) / EDGE) * MAX_STEP);
  if (x > right - EDGE) return depth(x - (right - EDGE));
  if (x < left + EDGE) return -depth(left + EDGE - x);
  return 0;
};
