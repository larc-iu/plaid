import { cn } from '../../lib/utils.js';
import { Button } from '../ui/button';

/**
 * The top of a project's Validation tab, the same in every app: the heading,
 * one line on what the tab checks, and the button that checks again. What is
 * listed below it is the app's own (values off a list, problems in a graph).
 *
 * The heading is an h2: the project's tab strip above it carries the page's
 * title.
 *
 * Props:
 * - `description`: the line under the heading.
 * - `busy`: a check is running. The button says so and cannot be pressed.
 * - `disabled`: nothing can be checked (the project is not set up).
 * - `onCheck`: runs the check again.
 * - `className`: merged over the header's own (its bottom margin).
 */
export const ValidationHeader = ({ description, busy, disabled, onCheck, className }) => (
  <div className={cn('mb-4 flex items-center justify-between gap-3', className)}>
    <div>
      <h2 className="text-2xl font-semibold tracking-tight">Validation</h2>
      <p className="mt-1 text-sm text-muted-foreground">{description}</p>
    </div>
    <Button variant="outline" className="shrink-0" onClick={onCheck} disabled={busy || disabled}>
      {busy ? 'Checking…' : 'Check again'}
    </Button>
  </div>
);
