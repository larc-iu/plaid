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
