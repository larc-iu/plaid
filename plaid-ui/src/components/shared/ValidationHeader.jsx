import { cn } from '../../lib/utils.js';
import { Button } from '../ui/button';
import { SectionHeader } from './SectionHeader.jsx';

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
  <SectionHeader
    title="Validation"
    description={description}
    className={cn('mb-4', className)}
    actions={
      <Button variant="outline" onClick={onCheck} disabled={busy || disabled}>
        {busy ? 'Checking…' : 'Check again'}
      </Button>
    }
  />
);
