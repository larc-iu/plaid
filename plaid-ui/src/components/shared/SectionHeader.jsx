import { cn } from '../../lib/utils.js';
import { TYPE } from '../../lib/typeScale.js';

/**
 * The heading of a project tab, the same on every tab in every app: the tab's
 * name as an h2 (the project's name above the tabs is the page's h1), an
 * optional line under it, and the tab's own actions at the right.
 *
 * Props:
 * - `title`: the heading.
 * - `description`: one line under it.
 * - `actions`: drawn at the right, beside the heading.
 * - `className`: merged over the row's own (its bottom margin).
 */
export const SectionHeader = ({ title, description, actions, className }) => (
  <div className={cn('mb-6 flex flex-wrap items-center justify-between gap-3', className)}>
    <div className="min-w-0">
      <h2 className={TYPE.section}>{title}</h2>
      {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
    </div>
    {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
  </div>
);
