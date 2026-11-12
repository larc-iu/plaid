import { useCallback, useEffect, useRef, useState } from 'react';
import { holdRun } from './useSavingGuard.js';

// The document's write lock, held while a service run is writing to it.
//
// A run outlives its dialog by design, which is the whole point of being able
// to close the box. That leaves a window where a service is rewriting tokens,
// glosses or the baseline while the document sits there looking editable, and
// every run ends in a `_reload()` that would throw away whatever was typed in
// the meantime. So the document goes read-only for as long as a run writes.
//
// Only runs that WRITE take the lock. Speech detection does not: neither the
// in-browser model nor a `detect-speech` service writes anything, and a
// proposal becomes a segment by being typed into, so locking would break the
// gesture the feature exists for.
//
// The lock also carries the run's progress, because the banner it puts over
// the document (RunBanner) is the one place a run shows: its dialog closes
// when the run starts, the run goes on when its tab is left, and a page that
// was reloaded rejoins it with no dialog at all. The holder says which step it
// is on (`step`) and what the worker reports (`report`), and the banner draws
// the step list, the bar and the status line from that.
//
// The holder also supplies `onCancel`, so the run can be stopped from wherever
// the lock is visible, and the banner says "Stopping…" as soon as it is. That
// matters most for a run this page did not start: a rejoined run lives in its
// own hook, so the tab's own dialog has no handle on it.
//
// `startedAt` is when the run began, for a run rejoined after a reload: its
// banner clock goes on from there rather than starting again at 0:00.
// `steps` names the steps of a run the browser orders (Auto-analyze, a
// transcript per channel). A run of one step names none.
//
// Closing or reloading the tab while a run holds the lock asks first
// (useSavingGuard's one leave question). Leaving the document inside the app
// unmounts the page that owns the lock: the holder's `onLeave` is called and
// the lock is let go. Auto-analyze stops after the step in flight then (Luke,
// 2026-11-12), and a service step's run record stays for the page that comes
// back to rejoin. Every other run is one request, which goes on regardless.
//
// `acquire` returns `{release, step, report, onProgress}`, or null when the lock is
// already held, which is also what stops a second run from starting on top of
// the first. (Each spot has its own useServiceRequest, so its `isProcessing`
// only guards against itself.)
export function useWriteLock() {
  // { label, startedAt, steps, stepIndex, percent, message, cancel }
  const [held, setHeld] = useState(null);
  // The state is one render behind a synchronous second acquire, so the ref is
  // what actually arbitrates.
  const heldRef = useRef(false);
  // The holder's leave and release, for the page going away.
  const holderRef = useRef(null);
  // Whether the page is mounted. StrictMode unmounts and mounts again at once,
  // which is not leaving, so a leave waits a tick to see that it stayed gone.
  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      setTimeout(() => {
        const holder = holderRef.current;
        if (mountedRef.current || !holder) return;
        holder.onLeave?.();
        holder.release();
      }, 0);
    };
  }, []);

  const acquire = useCallback(
    (label, { onCancel = null, onLeave = null, startedAt = null, steps = null } = {}) => {
      if (heldRef.current) return null;
      heldRef.current = true;
      const unhold = holdRun();
      let released = false;
      // Ignored once released, so a late progress event cannot resurrect a
      // finished run, or write into the run that holds the lock after it.
      const update = (patch) => {
        if (released) return;
        setHeld((cur) => (cur ? { ...cur, ...patch } : cur));
      };
      // What the worker reports. A percent left out stays as it was, and null
      // means unknown. An empty message keeps the last real one.
      const report = ({ percent, message } = {}) => {
        const patch = {};
        if (percent !== undefined) patch.percent = Number.isFinite(percent) ? percent : null;
        if (message) patch.message = message;
        if (Object.keys(patch).length) update(patch);
      };
      // Stop says so on the banner at once, for every run: a stop is answered
      // at the worker's next checkpoint, which may be a while, and the banner
      // is the only place the run shows (REV-RUN-2).
      const cancel = onCancel
        ? () => {
            report({ percent: null, message: 'Stopping…' });
            return onCancel();
          }
        : null;
      setHeld({
        label,
        startedAt: Number.isFinite(startedAt) ? startedAt : Date.now(),
        steps: steps?.length ? steps : [label],
        stepIndex: 0,
        // Unknown until the worker says otherwise, never 0%.
        percent: null,
        message: '',
        cancel,
      });
      const release = () => {
        if (released) return; // a release called twice must not free a later run
        released = true;
        heldRef.current = false;
        if (holderRef.current?.release === release) holderRef.current = null;
        unhold();
        setHeld(null);
      };
      holderRef.current = { onLeave, release };
      return {
        release,
        // Move to step `index`. A step starts with its fraction unknown, and its
        // name is the status line until the worker says something.
        step: (index) => update({ stepIndex: index, percent: null, message: '' }),
        report,
        // A service's progress event, as a request's `onProgress`: one with no
        // percent says the fraction is unknown.
        onProgress: (event) => report({ percent: event?.percent ?? null, message: event?.message }),
      };
    },
    [],
  );

  return { held, acquire };
}
