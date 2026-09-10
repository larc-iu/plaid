// Rows per bulk request, for every importer. Each chunk is ONE server
// transaction holding the single SQLite write lock for its whole duration, so
// what this bounds is how long another writer can be made to wait, not just
// how many round trips we make. A writer that arrives mid-chunk waits, and is
// refused with a 503 once the server's busy_timeout (5s by default) runs out,
// so keep a hold well under a second even on a large database. Nothing here
// may be unbounded: a document's token count is set by the data, not by us.
export const CHUNK = 500;

/**
 * Send `items` to a bulk endpoint in CHUNK-sized slices, concatenating the
 * ids each call returns so the caller still gets one id per input, in input
 * order. `check` runs before each slice so a cancel lands promptly.
 */
export async function bulkInChunks(items, check, send) {
  const ids = [];
  for (let i = 0; i < items.length; i += CHUNK) {
    check?.();
    const res = await send(items.slice(i, i + CHUNK));
    if (res?.ids) ids.push(...res.ids);
  }
  return ids;
}
