/**
 * Metadata ops: the body of every metadata PATCH, and the `metadata` of a
 * bulk update entry. An op is `{op: 'set', path, value}` or
 * `{op: 'delete', path}`, where `path` is a non-empty array of keys into the
 * nested metadata, the first a top-level key. See the manual, "Metadata".
 */

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
 * Throws where the server would refuse (a path through a non-object).
 * @param {Object|null|undefined} metadata
 * @param {Array<{op: string, path: string[], value?: any}>} ops
 * @returns {Object}
 */
export const applyMetadataOps = (metadata, ops) =>
  (ops || []).reduce((m, o) => {
    if (!Array.isArray(o.path) || o.path.length === 0) {
      throw new Error('A metadata op needs a non-empty path');
    }
    if (o.op !== 'set' && o.op !== 'delete') {
      throw new Error(`Unknown metadata op '${o.op}': expected set or delete`);
    }
    if (o.op === 'set' && !('value' in o)) {
      throw new Error('A set op needs a value');
    }
    return applyOp(m, o.path, 0, o);
  }, { ...(metadata || {}) });
