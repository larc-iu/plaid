import React, { useState } from 'react';
import { AudioLines, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { Slider } from '@/components/ui/slider';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { VAD_UI_DEFAULTS } from './useVadProposals.js';

// Speech detection: the button in the Recording header and the dialog behind
// it. Only the controls live here. What detection produces is shown where it
// is used, as outlined blocks on the timeline and as rows in the transcript,
// so the dialog can be closed and the proposals typed into.
//
// Every control re-derives the proposals from probabilities the model has
// already produced, so tuning is quick after the one slow pass. Only Detect
// runs the model, and it keeps running with the dialog shut.

const NumberField = ({ id, label, value, min, max, step, unit, onChange, disabled }) => (
  <div className="flex items-center justify-between gap-4">
    <Label htmlFor={id} className="text-sm font-normal">
      {label}
    </Label>
    <div className="flex items-baseline gap-1.5">
      <Input
        id={id}
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        className="h-8 w-24 text-sm tabular-nums"
        onChange={(e) => {
          const n = Number(e.target.value);
          if (Number.isFinite(n)) onChange(Math.min(max, Math.max(min, n)));
        }}
      />
      <span className="w-6 text-xs text-muted-foreground">{unit}</span>
    </div>
  </div>
);

export function VadDetection({ vad, readOnly = false, disabled = false }) {
  const [open, setOpen] = useState(false);
  const {
    params,
    setParam,
    resetParams,
    proposals,
    foundCount,
    status,
    progress,
    error,
    hasAnalysis,
  } = vad;
  const running = status === 'running';
  const count = proposals.length;
  const percent = Math.round(progress * 100);

  const summary =
    count > 0
      ? count === 1
        ? '1 proposed segment'
        : `${count} proposed segments`
      : foundCount === 0
        ? 'No speech found'
        : 'No proposals left';

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-9 w-9"
            onClick={() => setOpen(true)}
            disabled={readOnly || disabled}
            aria-label="Detect speech"
          >
            {running ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <AudioLines className="h-4 w-4" />
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          {running ? `Detecting speech, ${percent}%` : 'Detect speech'}
        </TooltipContent>
      </Tooltip>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Speech detection</DialogTitle>
            <DialogDescription>
              Proposed segments appear on the timeline and in the transcript. Each becomes a segment
              when you type into it.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-4 py-2">
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between gap-4">
                <Label htmlFor="vad-threshold" className="text-sm font-normal">
                  Speech threshold
                </Label>
                <span className="text-sm tabular-nums text-muted-foreground">
                  {params.threshold.toFixed(2)}
                </span>
              </div>
              <Slider
                id="vad-threshold"
                aria-label="Speech threshold"
                value={[params.threshold]}
                min={0.1}
                max={0.9}
                step={0.05}
                disabled={running}
                onValueChange={([v]) => setParam('threshold', Number(v.toFixed(2)))}
              />
            </div>
            <NumberField
              id="vad-min-silence"
              label="Shortest silence"
              unit="ms"
              value={params.minSilenceDurationMs}
              min={0}
              max={5000}
              step={10}
              disabled={running}
              onChange={(v) => setParam('minSilenceDurationMs', v)}
            />
            <NumberField
              id="vad-min-speech"
              label="Shortest segment"
              unit="ms"
              value={params.minSpeechDurationMs}
              min={0}
              max={5000}
              step={10}
              disabled={running}
              onChange={(v) => setParam('minSpeechDurationMs', v)}
            />
            <NumberField
              id="vad-max-speech"
              label="Longest segment"
              unit="s"
              value={params.maxSpeechDurationS}
              min={1}
              max={600}
              step={1}
              disabled={running}
              onChange={(v) => setParam('maxSpeechDurationS', v)}
            />
            <NumberField
              id="vad-pad"
              label="Padding"
              unit="ms"
              value={params.speechPadMs}
              min={0}
              max={1000}
              step={10}
              disabled={running}
              onChange={(v) => setParam('speechPadMs', v)}
            />

            {JSON.stringify(params) !== JSON.stringify(VAD_UI_DEFAULTS) && (
              <button
                type="button"
                onClick={resetParams}
                disabled={running}
                className="self-start text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
              >
                Reset settings
              </button>
            )}

            {running && (
              <div className="flex items-center gap-3">
                <Progress
                  value={progress > 0 ? percent : undefined}
                  label="Speech detection progress"
                  className="flex-1"
                />
                <span className="w-9 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                  {progress > 0 ? `${percent}%` : ''}
                </span>
              </div>
            )}

            {status === 'error' && <p className="text-sm text-destructive">{error}</p>}
            {status === 'ready' && <p className="text-sm text-muted-foreground">{summary}</p>}
          </div>

          <DialogFooter className="sm:justify-between">
            <div>
              {hasAnalysis && !running && (
                <Button variant="outline" onClick={vad.clear}>
                  Discard
                </Button>
              )}
            </div>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setOpen(false)}>
                Close
              </Button>
              {running ? (
                <Button variant="outline" onClick={vad.cancel}>
                  Cancel
                </Button>
              ) : (
                <Button onClick={vad.detect}>Detect</Button>
              )}
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
