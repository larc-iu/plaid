import { cn } from '../../lib/utils.js';

/**
 * A choice of one among a few, as one control in every app: a muted track
 * with the chosen segment lifted out of it in white. For a view switch or a
 * filter (Hits or Frequencies, Current or Outdated, a time window), not for
 * navigation, which is tabs.
 *
 * Props:
 * - `label`: the group's name for assistive technology.
 * - `value`, `onChange(value)`: the chosen option.
 * - `options`: `[{ value, label, count }]`, `count` drawn muted after the
 *   label when given.
 * - `className`: merged over the track's own.
 */
export const SegmentedControl = ({ label, value, onChange, options, className }) => (
  <div
    role="group"
    aria-label={label}
    className={cn(
      'inline-flex max-w-full items-center gap-0.5 rounded-md bg-muted p-0.5',
      className,
    )}
  >
    {options.map((o) => {
      const on = o.value === value;
      return (
        <button
          key={o.value}
          type="button"
          aria-pressed={on}
          onClick={() => onChange(o.value)}
          className={cn(
            'inline-flex h-7 items-center gap-1 whitespace-nowrap rounded-sm px-2.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            on
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {o.label}
          {o.count !== undefined && (
            <span className="tabular-nums text-muted-foreground">{o.count}</span>
          )}
        </button>
      );
    })}
  </div>
);
