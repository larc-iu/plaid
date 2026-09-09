import { Check, Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { formatElapsed } from '../hooks/useRunProgress.js';

// The one shape every service run wears (tokenize, transcribe, detect speech,
// auto-analyze). Body slots, in order:
//   1. what the run does and where its results land (`description`)
//   2. the method and its options (`children` — one ServiceMethodRow, or a
//      composite's several)
//   3. status: the bar, the step, the elapsed clock, the last message, or a
//      `notice` saying why the run cannot start
// Footer: a secondary action on the left, then Close and the run verb.
//
// The dialog can always be closed, and closing never cancels: a run outlives
// it, and the button that opened it carries the progress (ServiceRunButton).
export function ServiceRunDialog({
  open,
  onOpenChange,
  title,
  icon: Icon,
  description,
  children,
  progress,
  error,
  result,
  notice,
  runLabel,
  onRun,
  runDisabled = false,
  onCancel,
  secondary,
  className = 'max-w-2xl',
}) {
  const running = progress?.running;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Three grid rows — header, scrolling body, footer — so the footer stays
          on screen no matter how many options the chosen method declares. */}
      <DialogContent
        className={`${className} grid-rows-[auto_minmax(0,1fr)_auto] overflow-y-hidden`}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {Icon && <Icon className="h-4 w-4" />}
            {title}
          </DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>

        {/* -mx-1/px-1 keeps focus rings from being clipped by the scroll box. */}
        <div className="-mx-1 flex flex-col gap-5 overflow-y-auto px-1 py-1">
          {children}

          {!running && notice && <p className="text-sm text-muted-foreground">{notice}</p>}
          {running && <RunStatus progress={progress} />}
          {!running && error && <p className="text-sm text-destructive">{error}</p>}
          {!running && !error && result && (
            <p className="text-sm text-muted-foreground">{result}</p>
          )}
        </div>

        <DialogFooter className="sm:justify-between">
          <div>
            {secondary && (
              <Button variant="outline" onClick={secondary.onClick} disabled={secondary.disabled}>
                {secondary.label}
              </Button>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Close
            </Button>
            {running && onCancel ? (
              <Button variant="outline" onClick={onCancel}>
                Stop
              </Button>
            ) : (
              <Button onClick={onRun} disabled={running || runDisabled}>
                {running && <Loader2 className="h-4 w-4 animate-spin" />}
                {runLabel}
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// The bar, the elapsed clock, and the last thing the worker said. A run with
// several steps also lists them, so a long quiet step still shows its place.
function RunStatus({ progress }) {
  const { percent, message, elapsedMs, steps, stepIndex, stepCount } = progress;
  return (
    <div className="flex flex-col gap-2 border-t pt-4">
      {stepCount > 1 && (
        <ol className="flex flex-col gap-1">
          {steps.map((label, i) => (
            <li
              key={label}
              className={`flex items-center gap-2 text-xs ${
                i === stepIndex ? 'text-foreground' : 'text-muted-foreground'
              }`}
            >
              <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                {i < stepIndex ? (
                  <Check className="h-3.5 w-3.5" />
                ) : i === stepIndex ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/40" />
                )}
              </span>
              {label}
            </li>
          ))}
        </ol>
      )}
      <div className="flex items-center gap-3">
        <Progress
          value={Number.isFinite(percent) ? percent : undefined}
          label={stepCount > 1 ? `Step ${stepIndex + 1} of ${stepCount}` : 'Progress'}
          className="flex-1"
        />
        <span className="w-10 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
          {formatElapsed(elapsedMs)}
        </span>
      </div>
      <span className="text-sm text-muted-foreground" role="status">
        {stepCount > 1 ? `Step ${stepIndex + 1} of ${stepCount}. ${message}` : message}
      </span>
    </div>
  );
}
