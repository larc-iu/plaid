// The one time formatter for the Media tab. Alignment boundaries are set by
// dragging at up to 100 px/s and stored as float seconds, so the whole-second
// display this replaced hid the very digits a transcriber adjusts. Always
// milliseconds: `m:ss.mmm`, with an hours field only once a recording needs it.
export function formatTime(seconds) {
  const total = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  const ms = Math.round(total * 1000);
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const milli = ms % 1000;
  const minutes = h > 0 ? String(m).padStart(2, '0') : String(m);
  return `${h > 0 ? `${h}:` : ''}${minutes}:${String(s).padStart(2, '0')}.${String(milli).padStart(3, '0')}`;
}

// The inverse, for typed times: `h:mm:ss.mmm`, `m:ss.mmm`, or bare seconds,
// each with the fraction optional (`.5` is half a second). Returns seconds
// rounded to the millisecond, or null when the text is not a time.
const TIME_RE = /^\s*(?:(\d+):)?(?:(\d{1,2}):)?(\d{1,2}|\d+)(?:\.(\d{1,3}))?\s*$/;

export function parseTime(text) {
  const m = TIME_RE.exec(String(text ?? ''));
  if (!m) return null;
  const [, a, b, c, frac] = m;
  // With one colon the regex leaves `b` empty and puts the minutes in `a`.
  const hours = a !== undefined && b !== undefined ? Number(a) : 0;
  const minutes = b !== undefined ? Number(b) : a !== undefined ? Number(a) : 0;
  const seconds = Number(c);
  if ((a !== undefined || b !== undefined) && seconds >= 60) return null;
  if (a !== undefined && b !== undefined && minutes >= 60) return null;
  const milli = frac === undefined ? 0 : Number(frac.padEnd(3, '0'));
  return Math.round((hours * 3600 + minutes * 60 + seconds) * 1000 + milli) / 1000;
}
