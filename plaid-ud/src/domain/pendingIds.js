// A row the server has not made yet, shown at once.
//
// Every edit is optimistic, creates included: the row goes into the local
// document under a PENDING id before the round trip, and once the server
// answers, `settleIds` puts the server's ids in its place. Nothing else in the
// document names a pending id by then except the rows the same write made, so
// one pass over the document settles all of them.

let pendingSeq = 0;

// The prefix cannot collide with a server UUID.
export const pendingId = () => `pending:${++pendingSeq}`;

export const isPendingId = (id) => typeof id === 'string' && id.startsWith('pending:');

// Replace, in place, every `id`, `source` and `target` that `ids` (pending id to
// server id) names, anywhere under `node`.
export function settleIds(node, ids) {
  if (ids.size === 0 || node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) settleIds(item, ids);
    return;
  }
  for (const key of ['id', 'source', 'target']) {
    const value = node[key];
    if (typeof value === 'string' && ids.has(value)) node[key] = ids.get(value);
  }
  for (const value of Object.values(node)) {
    if (value !== null && typeof value === 'object') settleIds(value, ids);
  }
}
