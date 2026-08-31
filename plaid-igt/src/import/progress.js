// Progress reporting shared by the importers (flex, native, cldf).
//
// Each engine walks a list of documents and, inside each, a fixed sequence of
// steps. Both numbers have to reach the UI or the bar cannot move: the engines
// used to emit the document index only on the "Starting" event and omit it
// from every step after, so the counter snapped back to 1/N on the next step
// and the bar with it.

/**
 * An `onProgress` emitter bound to one document.
 *
 * `steps` is that engine's ordered step list, used to report how far through
 * the document we are. Without it a long single document leaves the bar
 * parked, which looks identical to being stuck.
 */
export function documentProgress({ onProgress, doc, index, total, steps = [] }) {
  return (step) => {
    const at = steps.indexOf(step);
    // Steps are reported as they BEGIN, so the first one is 0 progress. A step
    // the list does not know about does not move the bar backwards.
    const within = at < 0 || steps.length === 0 ? 0 : at / steps.length;
    onProgress?.({ phase: 'document', doc, step, index, total, within });
  };
}

/**
 * How far through the document phase a progress event is, 0..1. `index` is the
 * document being worked on, `within` how far into it, so the bar advances
 * across documents AND inside a single long one.
 */
export function documentFraction(progress, fallbackTotal) {
  const total = progress?.total ?? fallbackTotal ?? 0;
  if (!total) return 0;
  const done = (progress?.index ?? 0) + (progress?.within ?? 0);
  return Math.max(0, Math.min(done / total, 1));
}

/** "Name: step (3/78)" for the progress line. */
export function documentLabel(progress, fallbackTotal) {
  const total = progress?.total ?? fallbackTotal ?? 0;
  const n = (progress?.index ?? 0) + 1;
  const step = progress?.step ? `: ${progress.step}` : '';
  return `${progress?.doc ?? ''}${step}${total ? ` (${n}/${total})` : ''}`;
}
