import { useEffect, useRef, useState } from 'react';

// A running clock with millisecond digits redrawn every animation frame is a
// blur, and the eye keeps snagging on it. The running displays on the Media
// tab redraw at most this often while the recording plays; the moment it
// pauses they show the exact time.
export const RUNNING_TIME_MS = 200;

/**
 * `value`, republished at most once per `intervalMs`, with the latest value
 * always arriving once the interval has passed (a trailing flush). With
 * `bypass` the value passes straight through, so a paused clock is exact.
 */
export function useThrottledValue(value, intervalMs, { bypass = false } = {}) {
  const [shown, setShown] = useState(value);
  const lastRef = useRef(0);
  const timerRef = useRef(null);
  const latestRef = useRef(value);
  latestRef.current = value;

  useEffect(() => {
    if (bypass) {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      setShown(value);
      lastRef.current = Date.now();
      return;
    }
    const now = Date.now();
    const due = lastRef.current + intervalMs;
    if (now >= due) {
      lastRef.current = now;
      setShown(value);
      return;
    }
    if (timerRef.current) return; // a flush is already on its way
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      lastRef.current = Date.now();
      setShown(latestRef.current);
    }, due - now);
  }, [value, bypass, intervalMs]);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  return bypass ? value : shown;
}
