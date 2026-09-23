// A row the server has not made yet, shown at once.
//
// Every edit is optimistic, creates included: the row goes into the local
// document under a PENDING id before the round trip, and once the server
// answers, `settleIds` puts the server's ids in its place.
//
// Two things can still hold a pending id after that: a later edit, made while
// this one was in flight, whose server call is queued behind it; and the
// screen (an open label editor, a selected word). `settledId` turns such an id
// into the server's, and `stableKey` turns a server id back into the pending
// one it replaced, so a React key made from it does not change and remount
// what is on screen when the ids swap.

let pendingSeq = 0;
const serverIdOf = new Map();
const pendingIdOf = new Map();

// The prefix cannot collide with a server UUID.
export const pendingId = () => `pending:${++pendingSeq}`;

export const isPendingId = (id) => typeof id === 'string' && id.startsWith('pending:');

// The id the server knows this row by, once it has answered. Any other id is
// returned as it is.
export const settledId = (id) => serverIdOf.get(id) ?? id;

// The id a row was first shown under, for a React key.
export const stableKey = (id) => pendingIdOf.get(id) ?? id;

export function recordSettled(ids) {
  for (const [pending, server] of ids) {
    if (!server) continue;
    serverIdOf.set(pending, server);
    pendingIdOf.set(server, pending);
  }
}

const swap = (value, ids) => (typeof value === 'string' && ids.has(value) ? ids.get(value) : value);

// Replace, in place, every `id`, `source` and `target` that `ids` (pending id to
// server id) names anywhere under `node`, and every id in a span's `tokens`.
export function settleIds(node, ids) {
  if (ids.size === 0 || node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) settleIds(item, ids);
    return;
  }
  for (const key of ['id', 'source', 'target']) {
    if (key in node) node[key] = swap(node[key], ids);
  }
  if (Array.isArray(node.tokens) && node.tokens.some((t) => typeof t === 'string')) {
    node.tokens = node.tokens.map((t) => swap(t, ids));
  }
  for (const value of Object.values(node)) {
    if (value !== null && typeof value === 'object') settleIds(value, ids);
  }
}
