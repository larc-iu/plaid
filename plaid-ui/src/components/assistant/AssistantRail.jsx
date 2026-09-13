import { EdgeRail } from '../shared/EdgeRail.jsx';
import { AssistantMark } from './PlaidMarks.jsx';

// The way into the assistant when its panel is shut: the right-hand rail, the
// mirror of the history drawer's on the left. Both are EdgeRail, which carries
// the geometry and the behaviour; what is the assistant's own is the mark and
// the name.
//
// Named "Open the assistant", the way the history rail is named "Open history",
// and NOT plain "Assistant": the header carries a chip by that name, and two
// buttons with one name is ambiguous for a screen reader and for a locator.
export const AssistantRail = ({ onOpen }) => (
  <EdgeRail
    side="right"
    label="Open the assistant"
    title="Open the assistant"
    onClick={onOpen}
    className="z-30"
  >
    {/* The mark on its own ground. Its colours are fixed (see PlaidMarks) and
        chosen to sit on a light card or a dark one; straight onto the rail's
        grey the slate and the oxblood go to mud, and the rail darkens further
        on the very hover that reveals it. A bone disc is the ground it was
        drawn for, and it reads as a badge rather than a stain. */}
    <span className="rounded-full bg-background p-1 opacity-0 transition-opacity group-hover:opacity-100">
      <AssistantMark className="h-4 w-4" />
    </span>
  </EdgeRail>
);
