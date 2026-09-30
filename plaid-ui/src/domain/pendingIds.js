// A row the server has not made yet, shown at once.
//
// Every edit is optimistic, creates included: the row goes into the local
// document under an id this page mints (`newId`, a UUIDv7) before the round
// trip, and a create sends that id, so the server makes the row under it and
// a create sent again after a lost answer lands once. Until its create lands
// the id is PENDING (`isPendingId`).
//
// A row the server makes under an id of its own (a create that sends none, a
// text save that reshapes tokens, a copy) gets the server's ids when it
// answers: `settleIds` puts them in place of the ids shown. Two things can
// still hold an old id after that: a later edit, made while this one was in
// flight, whose server call is queued behind it, and the screen (an open
// label editor, a selected word). `settledId` turns such an id into the
// server's, and `stableKey` turns a server id back into the one it replaced,
// so a React key made from it does not change and remount what is on screen
// when the ids swap. For a row created under the id this page minted, both
// are the identity.
//
// Imports only the client's ids.js, which imports nothing, so the node suites
// can reach this file by relative path.

import { uuidv7 } from '../../../plaid-client-js/src/ids.js';

// Ids minted here whose create has not landed.
const minted = new Set();
const serverIdOf = new Map();
const pendingIdOf = new Map();

/** A fresh id for a row this page creates, pending until its create lands. */
export const newId = () => {
  const id = uuidv7();
  minted.add(id);
  return id;
};

/** The same as `newId`, under the name the apps used first. */
export const pendingId = newId;

export const isPendingId = (id) => typeof id === 'string' && minted.has(id);

// The id the server knows this row by, once it has answered. Any other id is
// returned as it is.
export const settledId = (id) => serverIdOf.get(id) ?? id;

// The id a row was first shown under, for a React key.
export const stableKey = (id) => pendingIdOf.get(id) ?? id;

const ID_IN_TEXT = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** `key` (a string naming rows by id, such as a cell key) with every id settled. */
export const settleKey = (key) => String(key ?? '').replace(ID_IN_TEXT, (id) => settledId(id));

/** Whether `key` names a row whose create has not landed. */
export const namesPendingId = (key) =>
  (String(key ?? '').match(ID_IN_TEXT) ?? []).some((id) => minted.has(id));

/**
 * The creates that minted these ids landed (a map or list of pending id to
 * the server's id): they are no longer pending. A pair whose server id
 * differs is remembered for `settledId` and `stableKey`.
 */
export function recordSettled(ids) {
  for (const [pending, server] of ids) {
    if (!server) continue;
    minted.delete(pending);
    if (server === pending) continue;
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

const isPlain = (v) =>
  v !== null &&
  typeof v === 'object' &&
  (Array.isArray(v) || Object.getPrototypeOf(v) === Object.prototype || !Object.getPrototypeOf(v));

// `value` with every id in it that the server has since answered for turned
// into the server's: a string, or plain objects and arrays of them, walked
// deep. The same reference back when nothing changed, so a component can
// follow the swap during render (`const f = followIds(x); if (f !== x) setX(f)`)
// without rendering forever.
export function followIds(value) {
  if (typeof value === 'string') return settledId(value);
  if (!isPlain(value)) return value;
  let changed = false;
  const next = Array.isArray(value) ? [] : {};
  for (const [k, v] of Object.entries(value)) {
    const f = followIds(v);
    if (f !== v) changed = true;
    next[k] = f;
  }
  return changed ? next : value;
}
