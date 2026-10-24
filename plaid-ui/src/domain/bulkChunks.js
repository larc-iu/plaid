// How many entities ride in one bulk request, and the loops that cut a list
// into them. ONE HOME for the number, because the reason for it is one fact
// about the server and not about any one screen or app.
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
//
// Imports nothing, so plain node reaches it.
export const CHUNK = 500;

/** `arr` in CHUNK-sized slices (or `size`-sized), as an array of arrays. */
export function chunk(arr, size = CHUNK) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * `send(slice)` for each CHUNK-sized slice of `items`, one after another, so
 * no request holds the write lock for a whole document's rows. Nothing is
 * sent for no items.
 */
export async function sendInChunks(items, send, size = CHUNK) {
  for (const slice of chunk(items, size)) await send(slice);
}
