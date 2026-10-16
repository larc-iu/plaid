import { cn } from '../../lib/utils.js';
import { gauge, gaugeLabel, gaugeTitle } from './usage.js';

// How full the conversation is, in the header beside the model that fills it.
// A bar as well as a number: the number answers "how full" and the bar answers
// "should I care", which is the question someone glancing at it is asking.
// The chat's header and the admin area's read-only transcript both draw it.
//
// Two limits fill: the model's context window (`usage`) and the stored
// record's size against the server's cap (`record`, as {bytes, cap}). The bar
// shows the fuller one, and the tooltip names it and gives both.
//
// `barOnly` is the narrow dock's: the bar alone, the number in the tooltip, so
// the model's name keeps its room (Luke, 2026-10-16). A gauge with no bar
// keeps its number, or it would show nothing.
export const UsageMeter = ({ usage, spend, record = null, barOnly = false }) => {
  const g = gauge(usage, record);
  const label = gaugeLabel(g);
  if (!label) return null;
  const numberShown = !barOnly || g.share === null;
  return (
    <span
      className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground"
      title={gaugeTitle(g, spend)}
      data-gauge={g.which || undefined}
    >
      {g.share !== null && (
        <span className="h-1.5 w-8 overflow-hidden rounded-full bg-muted">
          <span
            className={cn(
              'block h-full rounded-full',
              g.nearlyFull ? 'bg-warning' : 'bg-primary/50',
            )}
            style={{ width: `${Math.max(2, Math.round(g.share * 100))}%` }}
          />
        </span>
      )}
      {numberShown ? label : <span className="sr-only">{label}</span>}
    </span>
  );
};
