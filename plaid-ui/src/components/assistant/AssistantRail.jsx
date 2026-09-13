import { AssistantMark } from './PlaidMarks.jsx';

// The way into the assistant when its panel is shut: a handle on the right edge
// of the window, at the vertical middle, that widens on hover to show the mark.
//
// It mirrors the history rail on the LEFT edge of plaid-igt's document screen,
// deliberately: the two are the same kind of thing (a panel that is not open,
// waiting at the edge it opens from), so they should be the same gesture. This
// one sits a little wider and carries the app's own colour rather than a grey,
// because the assistant is reachable on every screen and the history rail is
// not: an affordance that is always there has to be legible without being
// hunted for.
//
// Hover WIDENS THE HANDLE, it does not open the panel. A panel that slid out
// whenever the cursor drifted to the right edge would open itself while the
// reader was reaching for a scrollbar.
//
// The accessible name is plain "Assistant", which is what it was when this was
// a button in the header band.
export const AssistantRail = ({ onOpen }) => (
  <button
    type="button"
    onClick={onOpen}
    aria-label="Assistant"
    title="Open the assistant"
    className="group fixed right-0 top-1/2 z-30 flex h-32 w-2.5 -translate-y-1/2 items-center justify-center rounded-l-md bg-primary/60 transition-all hover:w-11 hover:bg-primary"
  >
    {/* The mark on its own ground. Its colours are fixed (see PlaidMarks) and
        chosen to sit on a light card or a dark one; on a saturated primary the
        slate and the oxblood go to mud. A bone disc behind it is the ground it
        was drawn for, and it reads as a badge rather than a stain. */}
    <span className="rounded-full bg-background p-1 opacity-0 transition-opacity group-hover:opacity-100">
      <AssistantMark className="h-4 w-4" />
    </span>
  </button>
);
