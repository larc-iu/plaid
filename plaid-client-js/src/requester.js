// Who asked for a service run, named in what the run leaves behind.
//
// A plain service writes with its own token, so the History entry of a run
// reads "by <operator> (via <token>)" and the person who pressed the button is
// recorded nowhere. Core tells every service who asked (`requesterId` in the
// request data), and every app's services put that person in the History
// label and in what they store:
//
//   AnCast adjudication against lunch, requested by second
//
// This is the JS twin of `plaid_client.workflows.requester`, for a service
// authored with `serve`. The wording and the stored key are the same.
//
// The name is the requester's display name, which any signed-in user may
// read. When it cannot be read the id stands in for it, and with no requester
// at all the label is left as it was and nothing is stored.

/**
 * The person who asked for one service run. Both fields are null when nobody
 * asked.
 * @typedef {object} Requester
 * @property {string | null} id
 * @property {string | null} name
 * @property {(text: string) => string} label `"<text>, requested by <name>"`,
 *   or `text` when nobody asked.
 * @property {() => ({id: string, name: string | null} | null)} record
 *   `{ id, name }` for a stored report, or null when nobody asked.
 * @property {(detail?: Record<string, any>) => Record<string, any>} detail A
 *   machine stamp's `provDetail` with `requestedBy: <id>` added.
 */

/** The key a run's stored record names its requester under. */
export const REQUESTED_BY = /** @type {const} */ ("requestedBy");

/**
 * The person who asked for one run: `id` is their account (their email),
 * `name` how they are shown. Both are null when nobody asked.
 * @param {string | null} [id]
 * @param {string | null} [name]
 * @returns {Requester}
 */
export function makeRequester(id = null, name = null) {
  return {
    id,
    name,
    /** A History label with the requester named, or `text` when nobody asked. */
    label: (text) => (name ? `${text}, requested by ${name}` : text),
    /** `{ id, name }` for a stored report, or null when nobody asked. */
    record: () => (id ? { id, name } : null),
    /** A machine stamp's `provDetail` with the requester's id added. */
    detail: (detail = {}) => ({ ...(detail || {}), ...(id ? { [REQUESTED_BY]: id } : {}) }),
  };
}

/**
 * The requester of one request, from the `requesterId` core put in its data,
 * with their display name read through `client`.
 * @param {{users: {get(id: string): Promise<any>}}} client - A PlaidClient (only `users.get` is used)
 * @param {any} data - The request data a `serve` handler receives
 * @returns {Promise<Requester>}
 */
export async function requesterOf(client, data) {
  const id = data && typeof data === "object" ? data.requesterId || null : null;
  if (!id) return makeRequester();
  let name = null;
  try {
    name = (await client.users.get(id))?.displayName || null;
  } catch (error) {
    // The id is always there to fall back on, so a failed read costs the
    // label nothing but the nicer name.
    console.warn(`Could not read the requester ${id}: ${error?.message || error}`);
  }
  return makeRequester(id, name || id);
}
