// The time ruler's arithmetic: which ticks a stretch of the recording gets at
// a zoom, and how each labelled one reads. TimeRuler.jsx draws them.

// The steps a labelled tick may take, in seconds: the 1, 2, 5 series below a
// second, then the steps a clock face uses.
const STEPS = [
  0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900,
  1800, 3600,
];
// How many small ticks each labelled step is cut into, by its leading digit
// and for the clock steps by what reads as a round number.
const PARTS = { 1: 5, 2: 4, 5: 5, 15: 3, 30: 3, 60: 6, 120: 4, 900: 3, 1800: 3, 3600: 6 };
const partsOf = (step) => {
  if (PARTS[step]) return PARTS[step];
  const lead = Math.round(step / 10 ** Math.floor(Math.log10(step) + 1e-9));
  return PARTS[lead] ?? 5;
};

// The least room between two labels, in pixels: a label at a millisecond a
// pixel ("1:23.45") is about 40px of 10px mono, and the rest is air.
export const LABEL_GAP_PX = 72;
// Small ticks closer than this are left out.
const MINOR_GAP_PX = 6;

/**
 * The ruler's steps at `pixelsPerSecond`: `major`, the seconds between
 * labelled ticks, `minor`, between small ticks (null when they would crowd),
 * and `decimals`, the digits a label shows after the seconds.
 */
export function rulerScale(pixelsPerSecond) {
  const pps = pixelsPerSecond > 0 ? pixelsPerSecond : 1;
  const major = STEPS.find((s) => s * pps >= LABEL_GAP_PX) ?? STEPS[STEPS.length - 1];
  const minorStep = major / partsOf(major);
  const minor = minorStep * pps >= MINOR_GAP_PX ? minorStep : null;
  const decimals = major >= 1 ? 0 : Math.round(-Math.floor(Math.log10(major) + 1e-9));
  return { major, minor, decimals: Math.min(3, decimals) };
}

/**
 * A ruler label: `m:ss`, `h:mm:ss` once `hours` is set (a recording an hour
 * or longer), with `decimals` digits of the second after a point.
 */
export function rulerLabel(seconds, decimals = 0, hours = false) {
  const scale = 10 ** decimals;
  const units = Math.round(Math.max(0, seconds) * scale);
  const whole = Math.floor(units / scale);
  const frac = units % scale;
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  const ss = String(s).padStart(2, '0');
  const tail = decimals ? `.${String(frac).padStart(decimals, '0')}` : '';
  if (hours || h > 0) return `${h}:${String(m).padStart(2, '0')}:${ss}${tail}`;
  return `${m}:${ss}${tail}`;
}

/**
 * The ticks from `from` to `to` seconds (both included) at `pixelsPerSecond`:
 * `{ time, major }` in time order, each small tick that falls on a labelled
 * one given once, as labelled. Counted in whole steps, so no tick drifts by
 * the sum of rounding errors along a long recording.
 */
export function rulerTicks(from, to, pixelsPerSecond) {
  const { major, minor } = rulerScale(pixelsPerSecond);
  const step = minor ?? major;
  const per = Math.round(major / step);
  const first = Math.ceil(from / step - 1e-9);
  const last = Math.floor(to / step + 1e-9);
  const ticks = [];
  for (let k = Math.max(0, first); k <= last; k++) {
    ticks.push({ time: Math.round(k * step * 1e6) / 1e6, major: k % per === 0 });
  }
  return ticks;
}
