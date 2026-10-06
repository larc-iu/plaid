import { cn } from '../../lib/utils.js';
import { NEARLY_FULL, fullness, usageLabel, usageTitle } from './usage.js';

// How full the conversation is, in the header beside the model that fills it.
// A bar as well as a number: the number answers "how full" and the bar answers
// "should I care", which is the question someone glancing at it is asking.
// The chat's header and the admin area's read-only transcript both draw it.
export const UsageMeter = ({ usage, spend }) => {
  const label = usageLabel(usage);
  if (!label) return null;
  const f = fullness(usage);
  return (
    <span
      className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground"
      title={usageTitle(usage, spend)}
    >
      {f !== null && (
        <span className="h-1.5 w-8 overflow-hidden rounded-full bg-muted">
          <span
            className={cn(
              'block h-full rounded-full',
              f >= NEARLY_FULL ? 'bg-warning' : 'bg-primary/50',
            )}
            style={{ width: `${Math.max(2, Math.round(f * 100))}%` }}
          />
        </span>
      )}
      {label}
    </span>
  );
};
