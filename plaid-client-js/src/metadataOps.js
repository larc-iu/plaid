/**
 * Metadata ops: the body of every metadata PATCH, and the `metadata` of a
 * bulk update entry. An op is `{op: 'set', path, value}` or
 * `{op: 'delete', path}`, where `path` is a non-empty array of keys into the
 * nested metadata, the first a top-level key. See the manual, "Metadata".
 */

import { PLAID_NAMESPACE } from './roles.js';
import { PROVENANCE_KEYS } from './provenance.js';

const RESERVED_KEYS = new Set([PLAID_NAMESPACE, ...PROVENANCE_KEYS]);

/**
 * True for a top-level metadata key Plaid keeps for itself: the shared `plaid`
 * namespace (settings every app reads, such as the text direction) and the
 * provenance keys. Neither is ever a user's metadata field, so an app neither
 * lists it as one nor writes a field's value to it.
 * @param {string} key
 * @returns {boolean}
 */
export const isReservedMetadataKey = (key) => RESERVED_KEYS.has(key);

// The longest top-level key the server takes, in UTF-16 code units (Java's
// String length, which is what it counts).
const MAX_KEY_LENGTH = 200;

// Java's Character.isWhitespace, which the server's blank check uses: the
// Unicode space separators except the three no-break spaces, and the ASCII
// whitespace controls.
const isJavaWhitespace = (c) =>
  (/[\p{Zs}\p{Zl}\p{Zp}]/u.test(c) && c !== '\u00A0' && c !== '\u2007' && c !== '\u202F') ||
  /[\t\n\u000B\f\r\u001C-\u001F]/.test(c);

/**
 * True when the server accepts `k` as a top-level metadata key: not blank,
 * at most 200 UTF-16 code units, and no ASCII control character.
 * @param {string} k
 * @returns {boolean}
 */
const validMetadataKey = (k) =>
  typeof k === 'string' &&
  k.length <= MAX_KEY_LENGTH &&
  !/[\u0000-\u001F\u007F]/.test(k) &&
  ![...k].every(isJavaWhitespace);

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * The ops that set each top-level key of `fragment`, deleting a key whose
 * value is null. This is how a provenance fragment (verifyOnEdit,
 * contributeOnEdit, ...) is sent as a patch.
 * @param {Object|null|undefined} fragment
 * @returns {Array<{op: string, path: string[], value?: any}>}
 */
export const metadataOps = (fragment) =>
  Object.entries(fragment || {}).map(([k, v]) =>
    v === null ? { op: 'delete', path: [k] } : { op: 'set', path: [k], value: v },
  );

const applyOp = (node, path, depth, o) => {
  const [k, ...more] = path.slice(depth);
  if (more.length === 0) {
    const out = { ...node };
    if (o.op === 'set') out[k] = o.value;
    else delete out[k];
    return out;
  }
  const child = Object.prototype.hasOwnProperty.call(node, k) ? node[k] : undefined;
  if (child === undefined) {
    return o.op === 'set' ? { ...node, [k]: applyOp({}, path, depth + 1, o) } : node;
  }
  if (!isObject(child)) {
    throw new Error(
      `Metadata path ${JSON.stringify(path.slice(0, depth + 1))} holds a value that is not an object`,
    );
  }
  return { ...node, [k]: applyOp(child, path, depth + 1, o) };
};

/**
 * Apply ops to a local copy of an entity's metadata the way the server does,
 * for an optimistic update. Returns a new object and never mutates its input.
 * Throws on part of what the server refuses: an empty path, an op other than
 * set or delete, a path through a non-object, or a first key that is blank,
 * over 200 characters or holds a control character. The server's caps on
 * depth, key count, string length and size are not checked here.
 * @param {Object|null|undefined} metadata
 * @param {Array<{op: string, path: string[], value?: any}>} ops
 * @returns {Object}
 */
export const applyMetadataOps = (metadata, ops) =>
  (ops || []).reduce((m, o) => {
    if (!Array.isArray(o.path) || o.path.length === 0) {
      throw new Error('A metadata op needs a non-empty path');
    }
    if (!validMetadataKey(o.path[0])) {
      throw new Error('Invalid metadata key');
    }
    if (o.op !== 'set' && o.op !== 'delete') {
      throw new Error(`Unknown metadata op '${o.op}': expected set or delete`);
    }
    if (o.op === 'set' && !('value' in o)) {
      throw new Error('A set op needs a value');
    }
    return applyOp(m, o.path, 0, o);
  }, { ...(metadata || {}) });

/**
 * Merge a top-level fragment into a local copy, a null value deleting the
 * key: applyMetadataOps over metadataOps(fragment), so the same result as
 * sending those ops, refused where the server would refuse them. How an app
 * mirrors a provenance stamp (verifyOnEdit, contributeOnEdit, ...) on the row
 * it shows. Returns a new object.
 * @param {Object|null|undefined} metadata
 * @param {Object|null|undefined} fragment
 * @returns {Object}
 */
export const mergeMetadata = (metadata, fragment) =>
  applyMetadataOps(metadata, metadataOps(fragment));
