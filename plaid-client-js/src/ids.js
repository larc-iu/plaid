/**
 * Ids a client mints for what it creates.
 *
 * A create may name the id of the row it makes, so a create sent again after
 * its answer was lost lands under the same id or is told the id is taken
 * (409 with `id-taken`). The server takes only a UUIDv7 (RFC 9562), shaped
 * as its own ids are: a 48-bit millisecond timestamp, a 12-bit counter
 * within the millisecond, then 62 random bits. Reads are id-ordered, so ids
 * minted in one millisecond must still sort in the order they were made.
 */

let lastMs = 0;
let counter = 0;

const hex = Array.from({ length: 256 }, (_, i) =>
  i.toString(16).padStart(2, "0"),
);

/**
 * A fresh UUIDv7, later than every one this page minted before it.
 * @returns {string}
 */
export function uuidv7() {
  const now = Date.now();
  if (now > lastMs) {
    lastMs = now;
    counter = 0;
  } else if (counter < 0xfff) {
    counter += 1;
  } else {
    // This millisecond is full: take the next one rather than repeat an order.
    lastMs += 1;
    counter = 0;
  }
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  const high = Math.floor(lastMs / 0x100000000);
  const low = lastMs >>> 0;
  b[0] = (high >>> 8) & 0xff;
  b[1] = high & 0xff;
  b[2] = (low >>> 24) & 0xff;
  b[3] = (low >>> 16) & 0xff;
  b[4] = (low >>> 8) & 0xff;
  b[5] = low & 0xff;
  b[6] = 0x70 | (counter >>> 8);
  b[7] = counter & 0xff;
  b[8] = (b[8] & 0x3f) | 0x80;
  let s = "";
  for (let i = 0; i < 16; i++) {
    s += hex[b[i]];
    if (i === 3 || i === 5 || i === 7 || i === 9) s += "-";
  }
  return s;
}

/**
 * A random UUIDv4, for ids that need no order (an operation group, a lock
 * holder). Built on `crypto.getRandomValues`, since `crypto.randomUUID`
 * exists only in a secure context and a page served over plain HTTP from
 * another host than localhost is not one.
 * @returns {string}
 */
export function uuidv4() {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  let s = "";
  for (let i = 0; i < 16; i++) {
    s += hex[b[i]];
    if (i === 3 || i === 5 || i === 7 || i === 9) s += "-";
  }
  return s;
}

/**
 * A user id as the server stores it. A user's id is their email address,
 * kept trimmed and lowercased, so `Ana@Example.org` and `ana@example.org`
 * name one account. Compare a typed address with an id through this.
 * Anything but a string comes back unchanged.
 * @param {string} id
 * @returns {string}
 */
export function normalizeUserId(id) {
  return typeof id === "string" ? id.trim().toLowerCase() : id;
}
