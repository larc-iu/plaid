import { useId, useState } from 'react';
import { ChevronFirst, ChevronLast, ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '../../lib/utils.js';
import {
  RUN_BAR,
  HELP_TOGGLE,
  HELP_MARK,
  HELP_PANEL,
  RUN_COUNT,
  PAGER,
  PAGER_BUTTON,
  PAGER_LABEL,
  PAGER_FOOT,
} from './runBar.js';

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

const PAGER_STEPS = [
  { icon: ChevronFirst, label: 'First page', to: () => 0, at: 'start' },
  { icon: ChevronLeft, label: 'Previous page', to: (p) => p - 1, at: 'start' },
  null,
  { icon: ChevronRight, label: 'Next page', to: (p) => p + 1, at: 'end' },
  { icon: ChevronLast, label: 'Last page', to: (p, n) => n - 1, at: 'end' },
];

/**
 * The sentences' place in the RunBar, after the run: the count while they fit
 * on one page, the pager once they do not. `position="bottom"` is the same
 * pager under the last sentence, centred, and nothing on a single page.
 *
 * Takes the shape `usePagedList` returns, so a call site spreads it:
 *   <RunBarPager {...paged} onPage={setPage} />
 * Nothing at all without sentences: the empty state says so.
 */
export function RunBarPager({
  page,
  pageCount,
  rangeStart,
  rangeEnd,
  total,
  onPage,
  noun = 'sentence',
  position = 'top',
}) {
  if (!total) return null;
  if (pageCount <= 1) {
    if (position === 'bottom') return null;
    return (
      <span className={RUN_COUNT}>
        {total.toLocaleString()} {total === 1 ? noun : `${noun}s`}
      </span>
    );
  }
  const pager = (
    <div className={PAGER}>
      {PAGER_STEPS.map((step) => {
        if (!step) {
          return (
            <span key="label" className={PAGER_LABEL}>
              {rangeStart.toLocaleString()}–{rangeEnd.toLocaleString()} of {total.toLocaleString()}
            </span>
          );
        }
        const Icon = step.icon;
        const disabled = step.at === 'start' ? page === 0 : page >= pageCount - 1;
        return (
          <button
            key={step.label}
            type="button"
            className={PAGER_BUTTON}
            aria-label={step.label}
            title={step.label}
            disabled={disabled}
            onClick={() => onPage(step.to(page, pageCount))}
          >
            <Icon className="h-3.5 w-3.5" />
          </button>
        );
      })}
    </div>
  );
  return position === 'bottom' ? <div className={PAGER_FOOT}>{pager}</div> : pager;
}
