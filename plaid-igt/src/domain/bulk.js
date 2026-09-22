// How many entities ride in one bulk request, and the loops that cut a list
// into them. ONE HOME for the number, because the reason for it is one fact
// about the server and not about any one screen.
//
// Each chunk is ONE server transaction holding the single SQLite write lock
// for its whole duration, so what this bounds is how long another writer can
// be made to wait, not just how many round trips we make. A writer that
// arrives mid-chunk waits, and is refused with a 503 once the server's
// busy_timeout (5s by default) runs out, so keep a hold well under a second
// even on a large database. Nothing may be unbounded: a document's token
// count, or a lexicon's entry count, is set by the data and not by us.
//
// A bulk endpoint is also what makes the chunk worth this much: it dispatches
// the REST stack once and does the work set-wise, where a batch of one op per
// entity re-dispatches routing, auth, the ACL lookup and an operation each.
// Code that writes through an ATOMIC BATCH instead is bounded by plaid-core's
// 1000-op cap as well, and says so where it picks its own number.
export const CHUNK = 500;

/** `arr` in CHUNK-sized slices (or `size`-sized), as an array of arrays. */
export function chunk(arr, size = CHUNK) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Send `items` to a bulk endpoint in CHUNK-sized slices, concatenating the
 * ids each call returns so the caller still gets one id per input, in input
 * order. `check` runs before each slice so a cancel lands promptly.
 */
export async function bulkInChunks(items, check, send) {
  const ids = [];
  for (const slice of chunk(items)) {
    check?.();
    const res = await send(slice);
    if (res?.ids) ids.push(...res.ids);
  }
  return ids;
}
