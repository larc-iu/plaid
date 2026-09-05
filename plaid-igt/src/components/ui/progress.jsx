import * as React from 'react';
import { cn } from '@/lib/utils';

// A thin bar for something in flight. `value` is 0 to 100; leave it undefined
// while the amount cannot be known and the bar pulses at full width instead.
const Progress = React.forwardRef(({ value, label, className, ...props }, ref) => {
  const known = Number.isFinite(value);
  const pct = known ? Math.max(0, Math.min(100, value)) : 100;
  return (
    <div
      ref={ref}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={known ? Math.round(pct) : undefined}
      className={cn('h-2 w-full overflow-hidden rounded-full bg-muted', className)}
      {...props}
    >
      <div
        className={cn(
          'h-full rounded-full bg-primary transition-[width]',
          !known && 'animate-pulse bg-primary/60',
        )}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
});
Progress.displayName = 'Progress';

export { Progress };
