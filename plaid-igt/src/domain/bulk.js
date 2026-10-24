// How many entities ride in one bulk request, and the slices a list is cut
// into: one home for the number in plaid-ui (bulkChunks.js says why).
import { CHUNK, chunk } from '@ui/domain/bulkChunks.js';
import { createdIds, uuidv7 } from '@larc-iu/plaid-client';

export { CHUNK, chunk };

/**
 * Send `items` to a bulk endpoint in CHUNK-sized slices, concatenating the
 * ids each call returns so the caller still gets one id per input, in input
 * order. `check` runs before each slice so a cancel lands promptly. An answer
 * that lists ids lists one per item sent, or this throws: an id short would
 * pair every later input with the wrong row.
 */
export async function bulkInChunks(items, check, send) {
  const ids = [];
  for (const slice of chunk(items)) {
    check?.();
    const res = await send(slice);
    const got = createdIds(res);
    const listed = Array.isArray(res?.ids) || Array.isArray(res?.body?.ids);
    if (listed && got.length !== slice.length) {
      throw new Error(`The server answered ${got.length} ids for ${slice.length} rows.`);
    }
    ids.push(...got);
  }
  return ids;
}

/**
 * `specs` for a bulk create, each under an id minted here unless it names
 * one. A request whose answer was lost past the client's resends then made
 * rows that can be named, rather than rows nothing knows the ids of.
 */
export const withMintedIds = (specs) => specs.map((s) => (s.id ? s : { ...s, id: uuidv7() }));
