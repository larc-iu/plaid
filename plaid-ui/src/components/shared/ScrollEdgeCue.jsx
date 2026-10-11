import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '../../lib/utils.js';
import { stepToward } from '../../lib/scrollEdges.js';

/**
 * A chevron on each edge of a sideways-scrolling box that has more past it,
 * over the edge's fade. A click scrolls the box that way. The parent is
 * `relative` and holds the box. Keyboard and screen-reader users reach the
 * hidden content by the box itself (tabs by arrow keys, a table by its
 * links), so the chevrons stay out of the tab order and the tree.
 *
 * Props: `edges` from `hiddenEdges`, `box` a ref to the scrolling element,
 * `className` placing the chevrons on the cross axis (centred by default).
 */
export const ScrollEdgeCue = ({ edges, box, className = 'top-1/2 -translate-y-1/2' }) =>
  ['start', 'end'].map((edge) => {
    if (!edges[edge]) return null;
    const Icon = (edge === 'end') !== edges.rtl ? ChevronRight : ChevronLeft;
    return (
      <button
        key={edge}
        type="button"
        tabIndex={-1}
        aria-hidden="true"
        data-scroll-cue={edge}
        className={cn(
          'absolute z-10 inline-flex h-6 w-6 items-center justify-center rounded-full border bg-background text-muted-foreground shadow-sm hover:text-foreground',
          edge === 'end' ? 'end-0' : 'start-0',
          className,
        )}
        onClick={() => box.current && stepToward(box.current, edge, edges.rtl)}
      >
        <Icon className="h-3.5 w-3.5" />
      </button>
    );
  });
