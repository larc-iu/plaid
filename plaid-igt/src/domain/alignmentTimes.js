// Segments on the time axis: which ones may share a stretch of time, how far
// an edge may move, whether a proposed range is legal, and how to lay
// overlapping segments out in lanes.
//
// The alignment layer is `non-overlapping` in TEXT on the server; in TIME the
// only rule is this file's: two segments may overlap only when both carry a
// speaker label and the labels differ (cross-talk). One voice cannot overlap
// itself, and an unlabelled segment cannot be told apart from its neighbour,
// so those overlaps are the slip of a dragged edge and are stopped. Every
// writer of timeBegin/timeEnd goes through here: the timeline drag (clamped
// live), the transcript's time boxes and the domain method behind both
// (refused with the reason), and the load-time validator (reported, for data
// that got in some other way). The ELAN export puts each speaker on its own
// tier, where cross-talk is legal, and must drop a time for same-tier overlap.

const timeBeginOf = (t) => t.metadata?.timeBegin ?? 0;
const timeEndOf = (t) => t.metadata?.timeEnd ?? timeBeginOf(t);
const speakerOf = (t) => (t.metadata?.speaker || '').trim();
const byTime = (a, b) => timeBeginOf(a) - timeBeginOf(b);

/** Cross-talk: both labelled, and not the same voice. */
export const mayOverlap = (a, b) => {
  const sa = speakerOf(a);
  const sb = speakerOf(b);
  return sa !== '' && sb !== '' && sa !== sb;
};

/**
 * The tightest bounds the other segments impose on `id`: the latest end of a
 * conflicting segment that starts before it (`floor`) and the earliest start
 * of a conflicting one that starts after it (`ceiling`). Segments it may
 * overlap with do not count.
 */
export function timeBounds(tokens, id) {
  const token = (tokens || []).find((t) => t.id === id);
  if (!token) return { floor: 0, ceiling: Infinity };
  const start = timeBeginOf(token);
  let floor = 0;
  let ceiling = Infinity;
  for (const other of tokens) {
    if (other.id === id || mayOverlap(token, other)) continue;
    const ob = timeBeginOf(other);
    if (ob < start || (ob === start && other.id < id)) floor = Math.max(floor, timeEndOf(other));
    else ceiling = Math.min(ceiling, ob);
  }
  return { floor, ceiling };
}

/**
 * Where a dragged edge may go: inside the recording, no closer than
 * `minWidth` to the segment's other edge, and never into a segment it may not
 * overlap.
 */
export function clampResize(
  tokens,
  id,
  handle,
  time,
  { duration = Infinity, minWidth = 0.1 } = {},
) {
  const token = (tokens || []).find((t) => t.id === id);
  if (!token) return time;
  const { floor, ceiling } = timeBounds(tokens, id);
  if (handle === 'left') {
    return Math.max(floor, 0, Math.min(time, timeEndOf(token) - minWidth));
  }
  return Math.min(ceiling, duration, Math.max(time, timeBeginOf(token) + minWidth));
}

/**
 * Why `[timeBegin, timeEnd)` is not a legal range for segment `id`, or null.
 * `format` renders a time for the message.
 */
export function rangeProblem(
  tokens,
  id,
  timeBegin,
  timeEnd,
  { duration, minWidth = 0.01, format = String } = {},
) {
  if (timeEnd - timeBegin < minWidth) return 'A segment must end after it starts.';
  if (Number.isFinite(duration) && duration > 0 && timeEnd > duration + 0.001) {
    return `The recording ends at ${format(duration)}.`;
  }
  const { floor, ceiling } = timeBounds(tokens, id);
  if (timeBegin < floor) {
    return `The previous segment ends at ${format(floor)}. Only segments with different speakers may overlap.`;
  }
  if (timeEnd > ceiling) {
    return `The next segment starts at ${format(ceiling)}. Only segments with different speakers may overlap.`;
  }
  return null;
}

/** Every pair of segments that overlap in time and may not, in time order. */
export function conflictingPairs(tokens) {
  const sorted = [...(tokens || [])].sort(byTime);
  const pairs = [];
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const a = sorted[i];
      const b = sorted[j];
      if (timeBeginOf(b) >= timeEndOf(a)) break; // later ones start later still
      if (!mayOverlap(a, b)) pairs.push([a, b]);
    }
  }
  return pairs;
}

/**
 * Lane per segment id for drawing: overlapping segments stack instead of
 * painting over each other. Greedy in time order, first free lane wins.
 * Returns { lanes: Map<id, index>, count }.
 */
export function assignLanes(tokens) {
  const sorted = [...(tokens || [])].sort(byTime);
  const laneEnds = [];
  const lanes = new Map();
  for (const t of sorted) {
    const begin = timeBeginOf(t);
    let lane = laneEnds.findIndex((end) => end <= begin);
    if (lane < 0) {
      lane = laneEnds.length;
      laneEnds.push(0);
    }
    laneEnds[lane] = timeEndOf(t);
    lanes.set(t.id, lane);
  }
  return { lanes, count: Math.max(1, laneEnds.length) };
}
