import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

// Progress for one run of one service, in the shape every spot reports it.
//
// The point is that a run NEVER looks stalled while it is working. Three things
// carry that, and a caller gets all three for free:
//   - an elapsed clock that ticks whether or not the worker says anything,
//   - a named step out of a known total, so a long silence still has a place,
//   - an indeterminate bar when the fraction is genuinely unknown, rather than
//     a determinate bar pinned at 0%, which reads as broken.
//
// A worker that reports no percent is normal (a model pass emits messages, an
// import emits fractions), so `percent: null` means unknown and is not an error.
export function useRunProgress() {
  const [run, setRun] = useState(null); // { steps, startedAt } while running
  const [stepIndex, setStepIndex] = useState(0);
  const [percent, setPercent] = useState(null);
  const [message, setMessage] = useState('');
  const [elapsedMs, setElapsedMs] = useState(0);
  const startedAt = run?.startedAt ?? null;

  // Half-second tick so the seconds readout never visibly lags. This is the
  // only moving part when a worker goes quiet mid-step.
  useEffect(() => {
    if (!startedAt) return undefined;
    setElapsedMs(Date.now() - startedAt);
    const id = setInterval(() => setElapsedMs(Date.now() - startedAt), 500);
    return () => clearInterval(id);
  }, [startedAt]);

  const start = useCallback((steps = ['']) => {
    setRun({ steps, startedAt: Date.now() });
    setStepIndex(0);
    setPercent(null);
    setMessage(steps[0] || '');
  }, []);

  // Move to step `index`; a step always starts with its fraction unknown.
  const step = useCallback((index) => {
    setStepIndex(index);
    setPercent(null);
    setRun((r) => {
      setMessage(r?.steps?.[index] || '');
      return r;
    });
  }, []);

  // What a worker reports. Either field may be omitted.
  const report = useCallback(({ percent: p, message: m } = {}) => {
    if (p !== undefined) setPercent(Number.isFinite(p) ? p : null);
    // Keep the last real message rather than blanking on an empty update.
    if (m) setMessage(m);
  }, []);

  const finish = useCallback(() => {
    setRun(null);
    setPercent(null);
    setMessage('');
    setStepIndex(0);
  }, []);

  const steps = run?.steps ?? [];
  const stepCount = steps.length;

  // Overall fraction across the whole run. Null (indeterminate) only when
  // there is genuinely nothing to go on: a single step of unknown length.
  const overall = useMemo(() => {
    if (!run) return null;
    if (stepCount <= 1) return Number.isFinite(percent) ? percent : null;
    const within = Number.isFinite(percent) ? percent / 100 : 0;
    return ((stepIndex + within) / stepCount) * 100;
  }, [run, stepCount, stepIndex, percent]);

  return {
    running: !!run,
    steps,
    stepIndex,
    stepCount,
    percent: overall,
    // The line under the bar: what the worker last said, else the step's name.
    message: message || steps[stepIndex] || 'Working…',
    elapsedMs,
    start,
    step,
    report,
    finish,
  };
}

// m:ss, counting past an hour rather than wrapping.
export function formatElapsed(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

// Feed a useServiceRequest's live progress into a run. The hook reports
// percent/message as SSE events land, and this mirrors them without the
// caller wiring an effect per spot.
export function useMirroredProgress(progress, { percent, message, active }) {
  const report = progress.report;
  const seen = useRef('');
  useEffect(() => {
    if (!active) return;
    const key = `${percent}|${message}`;
    if (seen.current === key) return;
    seen.current = key;
    report({ percent: Number.isFinite(percent) ? percent : null, message });
  }, [active, percent, message, report]);
}
