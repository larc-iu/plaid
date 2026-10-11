import { useId, useState } from 'react';
import { cn } from '../../lib/utils.js';
import { RUN_BAR, HELP_TOGGLE, HELP_MARK, HELP_PANEL } from './runBar.js';

/**
 * The row over an annotation surface, the same in every app: the button that
 * runs a machine over the document at the start, the surface's help toggle at
 * the end, and the help itself in a panel under the row while it is open.
 * plaid-igt's lit-html grid draws the same row from `runBar.js`.
 *
 * Props:
 * - `run`: the run's opener (a ServiceSpotDialog with `size="sm"`), or null.
 * - `children`: anything else the row carries, after the run.
 * - `helpLabel`, `help`: the toggle's words and the panel's content. No
 *   `help`, no toggle.
 * - `className`: merged over the wrapper's own, which sets the row the gap
 *   under the tab rule that plaid-igt's tab bodies have.
 *
 * Draws nothing when it has nothing to carry.
 */
export function RunBar({ run = null, children = null, helpLabel, help = null, className }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  if (!run && !children && !help) return null;
  return (
    <div className={cn('pt-2', className)}>
      <div className={RUN_BAR}>
        {run}
        {children}
        {help && (
          <button
            type="button"
            className={HELP_TOGGLE}
            aria-expanded={open}
            aria-controls={panelId}
            onClick={() => setOpen((was) => !was)}
          >
            <span aria-hidden="true" className={HELP_MARK}>
              ?
            </span>
            {helpLabel}
          </button>
        )}
      </div>
      {help && open && (
        <div id={panelId} className={HELP_PANEL}>
          {help}
        </div>
      )}
    </div>
  );
}
