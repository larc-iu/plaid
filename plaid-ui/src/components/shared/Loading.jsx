import { cn } from '../../lib/utils.js';

/**
 * What a screen or a panel shows while it loads: one muted line of text.
 * A busy BUTTON shows the `Loader2` spinner inside itself instead, and nothing
 * else spins.
 *
 * Props:
 * - `label`: the text, "Loading…" unless the wait is for something the reader
 *   should be told about by name.
 * - `className`: merged over the default padding (`p-4`), so a caller that
 *   sits the line inside a padded box can pass `p-0`.
 */
export const Loading = ({ label = 'Loading…', className }) => (
  <p className={cn('p-4 text-sm text-muted-foreground', className)}>{label}</p>
);
