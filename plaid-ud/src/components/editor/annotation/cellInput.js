// The two things every editable cell in the annotation grid shares.

// Tab repeats far faster than the grid can move focus, and a held-down Tab over
// a thousand cells used to hang the browser. One clock for the whole grid, so
// the limit is on the grid and not on each cell in turn.
const TAB_INTERVAL_MS = 55;
let lastTabPress = 0;

/** True when this Tab came too soon after the last one and must be dropped. */
export const tabTooSoon = () => {
  const now = Date.now();
  if (now - lastTabPress < TAB_INTERVAL_MS) return true;
  lastTabPress = now;
  return false;
};

// Stable empty-options reference: an idle vocab cell passes this instead of the
// real suggestion list, so a grid of a thousand cells doesn't rank and group a
// tag set per cell per render. Options are built only while the cell is
// focused/editing, which is the only time the list can be open.
export const NO_OPTIONS = [];
