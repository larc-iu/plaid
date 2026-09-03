import React, { memo, useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { formatTime, parseTime } from './formatTime.js';

// A duration as a row of numbers, `m:ss.mmm` (with hours once a recording is
// that long): one small box per number, digits only. Typing fills the number
// under the caret and moves on when it is full, Left/Right move between the
// numbers, Up/Down step the number under the caret (milliseconds by 10, 100
// with Shift; seconds and minutes by 1, 10 with Shift), Enter saves and keeps
// the caret where it is, Esc puts the time back, leaving the field saves, and
// Shift+Space plays or pauses the segment. Nothing but a digit ever lands in
// a box.
//
// Hand-rolled rather than vendored: the only off-the-shelf segmented time
// input (React Aria's) does wall-clock times with no milliseconds and no
// durations, so it would need a fork to do this job.

const SEGMENTS = {
  h: { label: 'hours', width: 2, max: 99, step: 3600, shiftStep: 3600 },
  m: { label: 'minutes', width: 2, max: 59, step: 60, shiftStep: 600 },
  s: { label: 'seconds', width: 2, max: 59, step: 1, shiftStep: 10 },
  ms: { label: 'milliseconds', width: 3, max: 999, step: 0.01, shiftStep: 0.1 },
};
const ORDER = ['h', 'm', 's', 'ms'];

const pad = (n, width) => String(n).padStart(width, '0');

// Seconds -> the boxes' contents. Minutes are unpadded when there is no hours
// box, matching formatTime.
const split = (seconds, withHours) => {
  const total = Math.max(0, Math.round((Number(seconds) || 0) * 1000));
  const h = Math.floor(total / 3_600_000);
  const m = withHours ? Math.floor((total % 3_600_000) / 60_000) : Math.floor(total / 60_000);
  return {
    h: pad(h, 2),
    m: withHours ? pad(m, 2) : String(m),
    s: pad(Math.floor((total % 60_000) / 1000), 2),
    ms: pad(total % 1000, 3),
  };
};

const join = (parts, withHours) =>
  Math.round(
    ((withHours ? Number(parts.h) * 3600 : 0) +
      Number(parts.m) * 60 +
      Number(parts.s) +
      Number(parts.ms) / 1000) *
      1000,
  ) / 1000;

export const TimecodeField = memo(function TimecodeField({
  value,
  label,
  duration = 0,
  onCommit,
  onPlayToggle,
}) {
  const withHours = (Number(duration) || 0) >= 3600 || (Number(value) || 0) >= 3600;
  const keys = withHours ? ORDER : ORDER.slice(1);
  const [parts, setPartsState] = useState(() => split(value, withHours));
  const partsRef = useRef(parts);
  const dirtyRef = useRef(false);
  const inFlight = useRef(null);
  const inputs = useRef({});
  const setParts = (next) => {
    partsRef.current = next;
    setPartsState(next);
  };

  useEffect(() => {
    if (!dirtyRef.current) setParts(split(value, withHours));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, withHours]);

  const currentSeconds = () => join(partsRef.current, withHours);

  const revert = () => {
    dirtyRef.current = false;
    setParts(split(value, withHours));
  };

  const commit = () => {
    if (inFlight.current) return inFlight.current;
    const run = async () => {
      if (!dirtyRef.current) return true;
      const seconds = currentSeconds();
      if (Math.abs(seconds - value) < 0.0005) {
        revert();
        return true;
      }
      dirtyRef.current = false;
      // Normalize what was typed (a lone "7" in seconds is 07) before the answer.
      setParts(split(seconds, withHours));
      const ok = await onCommit(seconds);
      if (!ok) setParts(split(value, withHours));
      return ok;
    };
    inFlight.current = run().finally(() => {
      inFlight.current = null;
    });
    return inFlight.current;
  };

  const focusSegment = (key) => {
    const el = inputs.current[key];
    if (!el) return;
    el.focus({ preventScroll: true });
    el.select();
  };
  const neighbour = (key, dir) => {
    const i = keys.indexOf(key);
    return keys[i + dir] ?? null;
  };

  // The whole time moves by the step of the number under the caret, so a
  // nudge carries across the numbers (3.995 + 10 ms is 4.005) and never
  // leaves a box holding something it cannot show.
  const nudge = (key, direction, shift) => {
    const seg = SEGMENTS[key];
    const step = shift ? seg.shiftStep : seg.step;
    const ceiling = withHours ? Infinity : 3599.999;
    const next = Math.min(ceiling, Math.max(0, currentSeconds() + direction * step));
    dirtyRef.current = true;
    setParts(split(next, withHours));
  };

  const setSegment = (key, digits) => {
    const seg = SEGMENTS[key];
    const typed = digits.replace(/\D/g, '').slice(-seg.width);
    const n = Math.min(seg.max, Number(typed || '0'));
    dirtyRef.current = true;
    if (!typed) {
      // Whatever was typed held no digit: the box shows zeros, never junk.
      setParts({ ...partsRef.current, [key]: pad(0, key === 'm' && !withHours ? 1 : seg.width) });
      return;
    }
    // A number no further digit could extend (seconds "7" can only be 07) is
    // complete: show it padded and move on. Otherwise show the digits as typed.
    const complete = typed.length >= seg.width || n * 10 > seg.max;
    setParts({
      ...partsRef.current,
      [key]: complete ? pad(n, key === 'm' && !withHours ? 1 : seg.width) : typed,
    });
    if (complete) {
      const nextKey = neighbour(key, 1);
      if (nextKey) focusSegment(nextKey);
    }
  };

  const onKeyDown = (key) => (e) => {
    const plain = !e.ctrlKey && !e.metaKey && !e.altKey;
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      nudge(key, e.key === 'ArrowUp' ? 1 : -1, e.shiftKey);
    } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && plain && !e.shiftKey) {
      // Plain arrows move between boxes; Shift+Arrow is the tab's seek and is
      // left for the document to handle.
      e.preventDefault();
      const nextKey = neighbour(key, e.key === 'ArrowLeft' ? -1 : 1);
      if (nextKey) focusSegment(nextKey);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      commit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      revert();
    } else if (e.code === 'Space' && e.shiftKey && plain) {
      e.preventDefault();
      onPlayToggle?.();
    } else if (e.key === 'Backspace' || e.key === 'Delete') {
      e.preventDefault();
      dirtyRef.current = true;
      setParts({
        ...partsRef.current,
        [key]: pad(0, key === 'm' && !withHours ? 1 : SEGMENTS[key].width),
      });
    } else if (e.key.length === 1 && plain && !/\d/.test(e.key)) {
      e.preventDefault(); // nothing but a digit lands in a box
    }
  };

  // A pasted time replaces the whole value; pasted junk is ignored.
  const onPaste = (e) => {
    const text = e.clipboardData?.getData('text') ?? '';
    e.preventDefault();
    const seconds = parseTime(text);
    if (seconds === null) return;
    dirtyRef.current = true;
    setParts(split(seconds, withHours));
  };

  const onGroupBlur = (e) => {
    if (e.currentTarget.contains(e.relatedTarget)) return;
    commit();
  };

  const displayed = formatTime(currentSeconds());

  return (
    <div
      role="group"
      aria-label={label}
      data-value={displayed}
      className="inline-flex items-baseline font-mono text-[11px] leading-4 tabular-nums text-muted-foreground"
      onBlur={onGroupBlur}
      onPaste={onPaste}
    >
      {keys.map((key, i) => {
        const seg = SEGMENTS[key];
        const width = key === 'm' && !withHours ? Math.max(1, parts[key].length) : seg.width;
        return (
          <React.Fragment key={key}>
            {i > 0 && <span aria-hidden="true">{key === 'ms' ? '.' : ':'}</span>}
            <input
              ref={(el) => {
                inputs.current[key] = el;
              }}
              type="text"
              inputMode="numeric"
              value={parts[key]}
              aria-label={`${label} ${seg.label}`}
              spellCheck={false}
              autoComplete="off"
              style={{ width: `${width}ch` }}
              className={cn(
                'h-4 rounded-sm border-b border-transparent bg-transparent p-0 text-center',
                'hover:border-input focus:border-primary focus:text-foreground focus:outline-none',
              )}
              onFocus={(e) => e.target.select()}
              onChange={(e) => setSegment(key, e.target.value)}
              onKeyDown={onKeyDown(key)}
            />
          </React.Fragment>
        );
      })}
    </div>
  );
});
