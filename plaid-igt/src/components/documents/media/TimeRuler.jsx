import React from 'react';
import { rulerScale, rulerTicks, rulerLabel } from './timeRuler.js';

// The band's height above the track, which the ruler fills. The selection's
// card, stem and bracket sit in the same band, over the ruler.
export const RULER_BAND = 50;
const MAJOR_TICK = 8;
const MINOR_TICK = 3;
// The width of one character of a 10px mono label, near enough.
const LABEL_CHAR = 6.1;
// A label's distance from its tick.
const LABEL_GAP = 4;
// How far the selection's bracket stands outside it (Timeline's RING_OUTSET).
const BRACKET_OUTSET = 3;

// A time ruler in the band above the track, for the drawn stretch only (as
// the waveform is), so it stays the same cost at every zoom on a recording of
// any length. Ticks rise from the track's top edge and each labelled one
// carries its time beside it, in the transcript's mono, muted, so the ruler
// reads under the segments rather than beside them. A press on it is a press
// on the track: a click seeks and a drag selects.
//
// `clear` is the selection, `{ start, end }` in seconds, or null: no label is
// drawn under its bracket, which would cross it, and the card over it says
// the selection's times.
export const TimeRuler = React.memo(function TimeRuler({
  from,
  to,
  duration,
  pixelsPerSecond,
  clear = null,
}) {
  const end = Math.min(to, duration);
  if (!(duration > 0) || !(pixelsPerSecond > 0) || end <= from) return null;
  const { decimals } = rulerScale(pixelsPerSecond);
  const hours = duration >= 3600;
  const left = from * pixelsPerSecond;
  const width = Math.max(1, (end - from) * pixelsPerSecond);
  const x = (t) => Math.round((t - from) * pixelsPerSecond) + 0.5;
  const ticks = rulerTicks(from, end, pixelsPerSecond);
  let path = '';
  for (const t of ticks) {
    const h = t.major ? MAJOR_TICK : MINOR_TICK;
    path += `M${x(t.time)} ${RULER_BAND - h}V${RULER_BAND}`;
  }
  return (
    <svg
      data-timeline="ruler"
      aria-hidden="true"
      width={width}
      height={RULER_BAND}
      style={{
        position: 'absolute',
        left: `${left}px`,
        top: `-${RULER_BAND}px`,
        overflow: 'visible',
        cursor: 'pointer',
      }}
    >
      <path d={path} stroke="hsl(var(--muted-foreground) / 0.45)" strokeWidth="1" fill="none" />
      {ticks
        .filter((t) => t.major)
        .map((t) => ({ t, label: rulerLabel(t.time, decimals, hours) }))
        // A label that would run past the recording's end is left off, or it
        // would widen the track's scroll.
        .filter(({ t, label }) => {
          const room = label.length * LABEL_CHAR + LABEL_GAP;
          if ((duration - t.time) * pixelsPerSecond < room) return false;
          if (!clear) return true;
          const at = t.time * pixelsPerSecond;
          return (
            at + room < clear.start * pixelsPerSecond - BRACKET_OUTSET ||
            at > clear.end * pixelsPerSecond + BRACKET_OUTSET
          );
        })
        .map(({ t, label }) => (
          <text
            key={t.time}
            x={x(t.time) + LABEL_GAP}
            y={RULER_BAND - 2}
            className="font-mono"
            style={{
              fontSize: '10px',
              fontVariantNumeric: 'tabular-nums',
              fill: 'hsl(var(--muted-foreground))',
            }}
          >
            {label}
          </text>
        ))}
    </svg>
  );
});
