// Where each document's timeline was left: its zoom and the time at its left
// edge, so the Media tab opens on the stretch somebody was working on rather
// than on the whole recording fitted to the width. Per document, since a zoom
// is pixels per second and the right one depends on the recording. Per
// browser, like the playback speed: it is how one person looks at the
// recording, not something about it.

const KEY = 'plaid_igt_timeline_view';
// Documents remembered, the most recently used kept.
export const TIMELINE_VIEWS_KEPT = 200;

const readAll = () => {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

/**
 * The view last left on `documentId`'s timeline, or null.
 * @returns {{pixelsPerSecond: number, left: number}|null}
 */
export const readTimelineView = (documentId) => {
  if (!documentId) return null;
  const hit = readAll().find((entry) => Array.isArray(entry) && entry[0] === documentId);
  const view = hit?.[1];
  if (!view || !(view.pixelsPerSecond > 0) || !(view.left >= 0)) return null;
  return { pixelsPerSecond: view.pixelsPerSecond, left: view.left };
};

/** Keep `view` as `documentId`'s, first in line, dropping the oldest past the cap. */
export const writeTimelineView = (documentId, view) => {
  if (!documentId || !(view?.pixelsPerSecond > 0) || !(view.left >= 0)) return;
  const rest = readAll().filter((entry) => !(Array.isArray(entry) && entry[0] === documentId));
  const next = [
    [documentId, { pixelsPerSecond: view.pixelsPerSecond, left: view.left }],
    ...rest,
  ].slice(0, TIMELINE_VIEWS_KEPT);
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // A full or blocked store only loses the view for next time.
  }
};
