import { EdgeRail } from '../shared/EdgeRail.jsx';
import { AssistantMark } from './PlaidMarks.jsx';

// The way into the assistant when its panel is shut: the right-hand rail, the
// mirror of the history drawer's on the left. Both are EdgeRail, which carries
// the geometry and the behaviour; what is the assistant's own is the mark and
// the name.
//
// The accessible name is plain "Assistant", which is what it was when this was
// a button in the header band.
export const AssistantRail = ({ onOpen }) => (
  <EdgeRail
    side="right"
    label="Assistant"
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
