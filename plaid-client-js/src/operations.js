/**
 * Logical operations: the audit-log group a run of writes is labelled with,
 * its kind and reference, and the Idempotency-Keys that make a rerun send the
 * same requests. The client's beginOperation, keySeed, endOperation and
 * withOperation (whose notes say what each does) call these, with the client
 * as `client`. The twin of plaid-client-py's operations.py.
 */

import { uuidv4, uuidv7 } from "./ids.js";

/**
 * The kinds an operation may say it is (`?group-kind=`), the server's closed
 * list (plaid.sql.operation-group/kinds). An operation of any other kind is
 * refused when it begins, before it writes anything.
 */
export const OPERATION_KINDS = [
  "assistant-plan",
  "service-run",
  "import",
  "bulk-edit",
  "guess-adoption",
  "repair",
  "review",
];

/**
 * End the key frame `frame` of `group`, wherever it is among the frames open:
 * the frame under it, or the one open over it, numbers from then on. A plain
 * function, so a caller that borrows withOperation onto another object
 * (test doubles do) keeps it.
 */
export function dropFrame(group, frame) {
  if (!group || !frame || group.frames[0] === frame) return;
  group.frames = group.frames.filter((f) => f !== frame);
}

/**
 * The key for the next keyed request, and the strict-mode stamp it must
 * claim when an earlier run of its operation already sent it. `joins` says
 * whether the request joins the open logical operation.
 * Returns `{ key, pin, record }`: `pin` is undefined when nothing is pinned,
 * and `record(version)` pins what this request claimed, the first time.
 */
export function nextIdempotencyKey(client, joins) {
  const frame = joins ? client.operationGroup?.frames.at(-1) : null;
  const keys = frame?.keys;
  if (!keys) return { key: uuidv7(), pin: undefined, record: () => {} };
  const n = frame.count;
  frame.count += 1;
  const pinned = keys.stamps.has(n);
  return {
    key: `${keys.seed}.${n}`,
    pin: pinned ? keys.stamps.get(n) : undefined,
    record: (version) => {
      if (!pinned) keys.stamps.set(n, version ?? null);
    },
  };
}

/** See PlaidClient.beginOperation. */
export function beginOperation(client, message, { groupId, kind, ref, keys, minted } = {}) {
  if (kind != null && !OPERATION_KINDS.includes(String(kind))) {
    throw new Error(
      `Unknown operation kind "${kind}". It is one of: ${OPERATION_KINDS.join(", ")}.`,
    );
  }
  const frame = {
    keys: keys || null,
    count: 0,
    // Any iterable of ids (a Set, an array).
    minted: minted ? new Set(minted) : null,
    depth: 1,
  };
  const open = client.operationGroup;
  client._openedFrame = null;
  if (open) {
    // A nested operation joins the outer one. When it brings its own key
    // seed or ids (a queued edit run inside a longer operation), it numbers
    // the keys in a frame of its own until it ends, then the frame under it
    // numbers again.
    open.depth += 1;
    if (keys || minted) {
      frame.depth = open.depth;
      open.frames.push(frame);
      client._openedFrame = frame;
    }
    return open.id;
  }
  client.operationGroup = {
    id: groupId ? String(groupId) : uuidv4(),
    message: message == null ? null : String(message),
    kind: kind == null ? null : String(kind),
    ref: ref == null ? null : String(ref),
    depth: 1,
    written: false,
    refined: undefined,
    frames: [frame],
  };
  client._openedFrame = frame;
  return client.operationGroup.id;
}

/** See PlaidClient.keySeed. */
export function keySeed() {
  return { seed: uuidv7(), stamps: new Map() };
}

/** See PlaidClient.endOperation. */
export async function endOperation(client, message) {
  const group = client.operationGroup;
  if (!group) return;
  if (group.depth > 1) {
    // A frame begun at client depth by hand (beginOperation) ends here. One
    // begun by withOperation is ended by that call itself (_dropFrame).
    const top = group.frames.at(-1);
    if (group.frames.length > 1 && !top.owned && top.depth === group.depth) {
      group.frames.pop();
    }
    group.depth -= 1;
    return;
  }
  client.operationGroup = null;
  const refined = message !== undefined ? message : group.refined;
  if (refined !== undefined && group.written) {
    try {
      await client.operationGroups.update(group.id, refined);
    } catch (e) {
      // 404: the group never materialized server-side (every tagged write
      // failed or a batch was aborted). Nothing to relabel — not an error.
      if (e.status !== 404) throw e;
    }
  }
}

/** See PlaidClient.withOperation. */
export async function withOperation(client, message, fn, { kind, ref, groupId, keys, minted } = {}) {
  client.beginOperation(message, { kind, ref, groupId, keys, minted });
  const group = client.operationGroup;
  // The key frame client call opened is ended by client call, whatever else
  // began or ended meanwhile, not by whichever end comes at its depth.
  const frame = client._openedFrame;
  if (frame) frame.owned = true;
  const setMessage = (msg) => {
    if (group.depth === 1) group.refined = msg;
  };
  let result;
  try {
    result = await fn(setMessage);
  } catch (e) {
    // A relabel the server refuses (a token scoped to projects may not
    // relabel a group, which names none) must not take the place of the
    // error `fn` threw: the caller answers for that one.
    dropFrame(group, frame);
    try {
      await client.endOperation();
    } catch (relabel) {
      console.warn('The operation was not relabelled:', relabel);
    }
    throw e;
  }
  dropFrame(group, frame);
  await client.endOperation();
  return result;
}
