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

/** The key a run's stored record names its requester under. */
export const REQUESTED_BY = "requestedBy";

/**
 * The person who asked for one run: `id` is their account (their email),
 * `name` how they are shown. Both are null when nobody asked.
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
 * @param {object} client - A PlaidClient (only `users.get` is used)
 * @param {object} data - The request data a `serve` handler receives
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
