// Which edges of a box that scrolls sideways have content past them, and the
// cue that says so: the edge fades out (a mask, so it works on any ground) and
// a chevron sits on it (ScrollEdgeCue). The tab strips and DataTable use it.

export const NO_EDGES = { start: false, end: false, rtl: false };

const FADE = '2rem';

// Whether content lies past the start and the end of the box, in its own
// direction. In a right-to-left box `scrollLeft` runs from 0 down to minus
// the overflow, so its size is what counts.
export const hiddenEdges = (box) => {
  const overflow = box.scrollWidth - box.clientWidth;
  if (overflow <= 1) return NO_EDGES;
  const scrolled = Math.abs(box.scrollLeft);
  const rtl = getComputedStyle(box).direction === 'rtl';
  return { start: scrolled > 1, end: scrolled < overflow - 1, rtl };
};

// Kept when nothing changed, so a scroll does not re-render the box.
export const sameEdges = (a, b) => a.start === b.start && a.end === b.end && a.rtl === b.rtl;

const fadeMask = ({ start, end, rtl }) => {
  if (!start && !end) return null;
  const toward = rtl ? 'to left' : 'to right';
  const from = start ? `transparent, black ${FADE}` : 'black';
  const to = end ? `black calc(100% - ${FADE}), transparent` : 'black';
  return `linear-gradient(${toward}, ${from}, ${to})`;
};

// The style a box wears for its edges, merged over its own.
export const fadeStyle = (edges, style) => {
  const mask = fadeMask(edges);
  return mask ? { maskImage: mask, WebkitMaskImage: mask, ...style } : style;
};

// Three quarters of the box towards `edge` ('start' or 'end').
export const stepToward = (box, edge, rtl) => {
  const sign = (edge === 'end' ? 1 : -1) * (rtl ? -1 : 1);
  box.scrollBy({ left: sign * Math.max(80, box.clientWidth * 0.75), behavior: 'smooth' });
};
