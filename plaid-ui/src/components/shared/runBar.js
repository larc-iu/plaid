import { cn } from '../../lib/utils.js';
import { buttonVariants } from '../ui/button.jsx';

// The classes of the row over every annotation surface (igt's Analyze grid,
// ud's tree and grid, umr's canvas): the button that runs a machine over the
// document first, the surface's help toggle last, and the help's panel under
// the row. RunBar draws it in React. plaid-igt's lit-html island takes the
// same strings, so the three rows cannot drift apart.

export const RUN_BAR = 'flex min-h-9 flex-wrap items-center gap-3';

// The run button is the History button's twin: outline, small, its icon at
// 16px. ServiceRunButton takes `size="sm"` for it.
export const RUN_BUTTON = cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'gap-1.5');

export const HELP_TOGGLE =
  'group ms-auto inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

export const HELP_MARK =
  'inline-flex h-4 w-4 items-center justify-center rounded-full border border-border font-medium group-aria-expanded:border-primary group-aria-expanded:bg-primary group-aria-expanded:text-primary-foreground';

export const HELP_PANEL =
  'mt-2 max-w-3xl rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground';
