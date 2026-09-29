/**
 * Batch refs: a write in a batch that uses the id an earlier write in the
 * same batch creates.
 *
 * `b.ref()` returns a BatchRef, which the caller puts in a later write's
 * body where the id goes. When that write is queued, each BatchRef is taken
 * out of the body (null is left in its place) and recorded beside it as
 * `refs: [{ at: [key or index, ...], op: n, index?: k }]`, which the server
 * fills in. The server never searches a body, so user data of any shape,
 * `{ $ref: 0 }` included, is stored as sent. A BatchRef is a class instance
 * no JSON value can be, so data can never be taken for one here either.
 */

const MISPLACED =
  "b.ref() stands for an id only in the body of a later write on the same batch";

export class BatchRef {
  #batch;

  constructor(batch, op, index) {
    this.#batch = batch;
    /** The op, counted from 0 in the batch, whose id this stands for. */
    this.$ref = op;
    /** For a bulk create, which of its ids. */
    if (index !== undefined) this.index = index;
    Object.freeze(this);
  }

  belongsTo(batch) {
    return this.#batch === batch;
  }

  // Sent anywhere but a queued body (a call made on the client, a path, a
  // query), a ref would go out as something the server takes for data.
  toJSON() {
    throw new Error(MISPLACED);
  }

  [Symbol.toPrimitive]() {
    throw new Error(MISPLACED);
  }
}

/**
 * A BatchRef for op `opIndex` of `batch` (negative counts from the end, -1
 * is the op queued last), fixed when it is called.
 */
export function makeBatchRef(batch, opIndex, index) {
  const n = opIndex < 0 ? batch.operations.length + opIndex : opIndex;
  if (!Number.isInteger(n) || n < 0 || n >= batch.operations.length) {
    throw new Error(`No operation ${opIndex} has been queued on this batch`);
  }
  if (index !== undefined && !(Number.isInteger(index) && index >= 0)) {
    throw new Error(`A ref's index must be a whole number, not ${index}`);
  }
  return new BatchRef(batch, n, index);
}

const isPlainObject = (v) => {
  if (v === null || typeof v !== "object") return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};

function holdsRef(v) {
  if (v instanceof BatchRef) return true;
  if (Array.isArray(v)) return v.some(holdsRef);
  if (isPlainObject(v)) {
    for (const k in v) if (holdsRef(v[k])) return true;
  }
  return false;
}

/**
 * `body` with each BatchRef in it replaced by null, and the `refs` that say
 * where they were, or `refs` null when it holds none (the body is then
 * returned as it was).
 */
export function takeRefs(batch, body) {
  if (!holdsRef(body)) return { body, refs: null };
  const refs = [];
  const at = [];
  const take = (v) => {
    if (v instanceof BatchRef) {
      if (!v.belongsTo(batch)) throw new Error(MISPLACED);
      refs.push(
        v.index === undefined
          ? { at: [...at], op: v.$ref }
          : { at: [...at], op: v.$ref, index: v.index },
      );
      return null;
    }
    if (!holdsRef(v)) return v;
    if (Array.isArray(v)) {
      return v.map((x, i) => {
        at.push(i);
        const out = take(x);
        at.pop();
        return out;
      });
    }
    const out = {};
    for (const k of Object.keys(v)) {
      at.push(k);
      out[k] = take(v[k]);
      at.pop();
    }
    return out;
  };
  return { body: take(body), refs };
}

/**
 * `refs` counted from `start`, for an op in a batch sent in several requests
 * (the server counts within one request). A ref to an op of an earlier
 * request cannot resolve, so it throws before anything goes.
 */
export function rebaseRefs(refs, start) {
  return refs.map((r) => {
    if (r.op < start) {
      throw new Error(
        `Operation ${start} and later are sent in a request of their own, ` +
          `so an operation among them cannot use the id operation ${r.op} creates`,
      );
    }
    return { ...r, op: r.op - start };
  });
}
