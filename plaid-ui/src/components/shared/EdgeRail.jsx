import { cn } from '../../lib/utils.js';

// A panel that is not open, waiting at the edge it opens from: a slim rail
// against the left or right of the window, at the vertical middle, that widens
// under the pointer to show what it opens.
//
// There are two, the history drawer's and the assistant's, on opposite edges of
// the same screen. They are the same gesture, so they are one component: a
// reader who learns the one on the left has learned the one on the right, and a
// change to the feel of it happens once instead of drifting apart in two files.
//
// Hover WIDENS THE RAIL; it does not open the panel. One that slid out whenever
// the cursor drifted to an edge would open itself while the reader was reaching
// for a scrollbar.
//
// Full class strings per side, never interpolated: Tailwind scans the source as
// text, and a class assembled at runtime is a class that was never generated.
const SIDE = {
  left: 'left-0 rounded-r-md',
  right: 'right-0 rounded-l-md',
};

export const EdgeRail = ({ side, label, title, onClick, className, children }) => (
  <button
    type="button"
    onClick={onClick}
    aria-label={label}
    title={title}
    className={cn(
      'group fixed top-1/2 flex h-28 w-4 -translate-y-1/2 items-center justify-center bg-neutral-400 transition-all hover:w-11 hover:bg-neutral-600',
      SIDE[side],
      className,
    )}
  >
    {children}
  </button>
);
