import { useEffect, useState } from 'react';
import { Check, Loader2 } from 'lucide-react';
import { Button } from '../ui/button.jsx';
import { Progress } from '../ui/progress.jsx';
import { Notice } from '../shared/Notice.jsx';
import { cn } from '../../lib/utils.js';
import { formatElapsed, overallPercent } from '../../hooks/useRunProgress.js';

// The one place a run's progress shows, over the document, on every tab: the
// run's name, its steps when it has several, the bar, what the worker last
// said, the elapsed clock and Stop. Its dialog closes when the run starts,
// and a page that was reloaded rejoins the run with no dialog at all.
//
// It is information, not a warning: the info tone, and an icon that turns
// because the run is moving. The clock ticks here in its own right, so a run
// that reports nothing for a minute still visibly has a minute on it.
//
// The props are the write lock's holder (useWriteLock): `steps` always names
// at least one, `percent` null is unknown and pulses, `cancel` is Stop.
// `paused` false leaves out "Editing paused.", for an assistant job, which
// holds no write lock and leaves the document editable.
const Running = ({ className, ...rest }) => (
  <Loader2 className={cn(className, 'animate-spin')} {...rest} />
);

export function RunBanner({
  label,
  startedAt,
  steps = [],
  stepIndex = 0,
  percent,
  message,
  cancel,
  paused = true,
}) {
  const [elapsedMs, setElapsedMs] = useState(0);

  useEffect(() => {
    if (!startedAt) return undefined;
    setElapsedMs(Date.now() - startedAt);
    const id = setInterval(() => setElapsedMs(Date.now() - startedAt), 500);
    return () => clearInterval(id);
  }, [startedAt]);

  const stepCount = steps.length;
  const several = stepCount > 1;
  const place = several ? `Step ${stepIndex + 1} of ${stepCount}` : null;
  // Never blank: what the worker said, else the step's name, else that it works.
  const said = message || (several ? steps[stepIndex] : '') || 'Working…';
  const overall = overallPercent(stepCount, stepIndex, percent);

  return (
    <Notice tone="info" icon={Running} className="mb-4 px-4 py-3" data-run-banner="">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <p className="font-medium">{label}</p>
        {paused && <p className="text-xs text-muted-foreground">Editing paused.</p>}
        <span className="ml-auto text-xs tabular-nums text-muted-foreground">
          {formatElapsed(elapsedMs)}
        </span>
        {/* The only way to stop a run this page did not start: it lives in its
            own hook, so no tab's dialog has a handle on it. */}
        {cancel && (
          <Button variant="outline" size="sm" className="h-7" onClick={cancel}>
            Stop
          </Button>
        )}
      </div>
      {several && (
        <ol className="mt-2 flex flex-wrap gap-x-4 gap-y-1" aria-label="Steps">
          {steps.map((name, i) => (
            <li
              key={`${i}:${name}`}
              aria-current={i === stepIndex ? 'step' : undefined}
              className={cn(
                'flex items-center gap-1.5 text-xs',
                i === stepIndex ? 'font-medium text-foreground' : 'text-muted-foreground',
              )}
            >
              <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                {i < stepIndex ? (
                  <Check className="h-3.5 w-3.5" aria-hidden="true" />
                ) : (
                  <span
                    className={cn(
                      'h-1.5 w-1.5 rounded-full',
                      i === stepIndex ? 'bg-primary' : 'bg-muted-foreground/40',
                    )}
                  />
                )}
              </span>
              {name}
            </li>
          ))}
        </ol>
      )}
      <Progress
        value={Number.isFinite(overall) ? overall : undefined}
        label={place ?? 'Progress'}
        className="mt-2"
      />
      <p className="mt-1.5 text-xs" role="status">
        {place ? `${place}. ${said}` : said}
      </p>
    </Notice>
  );
}
