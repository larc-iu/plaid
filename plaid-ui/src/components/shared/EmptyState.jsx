import { showsTartan } from '../../domain/projectTartan.js';
import { cn } from '../../lib/utils.js';
import { PlaidMark } from '../assistant/PlaidMarks.jsx';
import { ProjectTartan } from './ProjectTartan.jsx';

/**
 * What a list or a page shows when it has nothing in it, one shape in every
 * app: a small swatch (the project's plaid inside a project, the product's
 * mark elsewhere), one muted line, an optional second, and an optional action.
 *
 * Props:
 * - `project`: inside a project, so its plaid is the swatch. Without one, or
 *   with its plaid turned off, the product's mark.
 * - `title`: the line ("No documents yet.").
 * - `hint`: one more, smaller, where the line needs it.
 * - `action`: a button or a link drawn under the text.
 * - `className`: merged over the box's own padding.
 */
export const EmptyState = ({ project, title, hint, action, className }) => (
  <div
    className={cn('flex flex-col items-center gap-2 px-4 py-10 text-center', className)}
    data-testid="empty-state"
  >
    {showsTartan(project) ? (
      <ProjectTartan project={project} size={32} className="opacity-70" />
    ) : (
      <PlaidMark className="h-7 w-7 opacity-50" />
    )}
    <p className="text-sm text-muted-foreground">{title}</p>
    {hint && <p className="max-w-md text-xs text-muted-foreground">{hint}</p>}
    {action && <div className="mt-1">{action}</div>}
  </div>
);
