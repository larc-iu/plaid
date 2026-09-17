// Comparing two project snapshots (e2e/fidelity/snapshot.mjs) and saying what
// the differences are about.
//
// `diffSnapshots` walks both values and lists every place they differ, by path.
// Rows that carry an id-free key (layers, documents, tokens, spans,
// vocabularies, entries) are matched by that key, so one missing token reads as
// one missing token rather than as every later row shifting by one. Rows with
// no key (links, comments, relations, guidelines) are matched as a multiset of
// their canonical strings. Nothing ever formats a whole structure: node's
// deepEqual once spent 20 GB describing a reordered array (see
// plaid_native_roundtrip_e2e_oom.md), so every value printed is cut short.
//
// `attribute` names the catalog features a difference touches, by counting
// every feature on both sides and keeping the ones whose counts differ. A
// difference that moves no count is still listed by path, and is itself a
// finding: the catalog has no feature that sees it.

import { stableStringify } from './stable.js';
import { FEATURES } from './catalog.js';

/** A deep copy of a snapshot, which is plain JSON. */
export const clone = (v) => structuredClone(v);

// Which property keys an array's rows by, per path segment name.
const ROW_KEY = {
  layers: 'key',
  vocabularies: 'key',
  items: 'key',
  documents: 'key',
  tokens: 'key',
  spans: 'key',
  texts: 'layer',
};

const MAX_VALUE = 100;
const show = (v) => {
  const s = v === undefined ? 'absent' : stableStringify(v);
  return s.length > MAX_VALUE ? `${s.slice(0, MAX_VALUE)}...` : s;
};

const kind = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

/**
 * Every difference between `expected` and `actual`, as
 * `{path, expected, actual}` with both values already cut to a printable
 * string. Stops after `limit` differences and says so in the last row.
 */
export function diffSnapshots(expected, actual, { limit = 500 } = {}) {
  const out = [];
  const push = (path, a, b) => {
    if (out.length < limit) out.push({ path, expected: show(a), actual: show(b) });
    else if (out.length === limit) out.push({ path: '...', expected: 'more', actual: 'more' });
  };

  const walk = (a, b, path, name) => {
    if (out.length > limit) return;
    if (a === b) return;
    if (kind(a) !== kind(b)) return push(path, a, b);
    if (kind(a) === 'array') return walkArray(a, b, path, name);
    if (kind(a) === 'object') {
      for (const k of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
        if (a[k] === undefined && b[k] === undefined) continue;
        walk(a[k], b[k], `${path}.${k}`, k);
      }
      return;
    }
    push(path, a, b);
  };

  const walkArray = (a, b, path, name) => {
    const keyProp = ROW_KEY[name];
    const keyed = keyProp && [...a, ...b].every((r) => r && typeof r === 'object' && keyProp in r);
    if (keyed) {
      const left = new Map(a.map((r) => [r[keyProp], r]));
      const right = new Map(b.map((r) => [r[keyProp], r]));
      for (const [k, row] of left) {
        const at = `${path}[${k}]`;
        if (!right.has(k)) push(at, row, undefined);
        else walk(row, right.get(k), at, null);
      }
      for (const [k, row] of right) if (!left.has(k)) push(`${path}[${k}]`, undefined, row);
      // Order is data for layers only through `position`, which is compared above.
      return;
    }
    const rows =
      a.every((r) => r && typeof r === 'object') && b.every((r) => r && typeof r === 'object');
    if (!rows) {
      if (stableStringify(a) !== stableStringify(b)) push(path, a, b);
      return;
    }
    // Unkeyed rows: what is on one side only is the difference, and when both
    // hold the same rows, their order is. Order is data in these lists (the
    // document metadata fields, the orthographies, a tagset's values), and the
    // snapshot already puts the ones whose order is not (links, comments) in a
    // canonical one.
    const count = new Map();
    for (const r of b) {
      const s = stableStringify(r);
      count.set(s, (count.get(s) ?? 0) + 1);
    }
    const missing = [];
    for (const r of a) {
      const s = stableStringify(r);
      if (count.get(s)) count.set(s, count.get(s) - 1);
      else missing.push(r);
    }
    const extraStrings = new Set([...count].filter(([, n]) => n > 0).map(([s]) => s));
    for (const r of missing) push(`${path}[-]`, r, undefined);
    for (const r of b) {
      const s = stableStringify(r);
      if (extraStrings.has(s)) {
        push(`${path}[+]`, undefined, r);
        extraStrings.delete(s);
      }
    }
    if (!missing.length && stableStringify(a) !== stableStringify(b)) {
      push(`${path} (order)`, a.map(stableStringify), b.map(stableStringify));
    }
  };

  walk(expected, actual, '', null);
  return out;
}

/**
 * The catalog features whose counts differ between two snapshots:
 * `[{key, expected, actual}]`, in catalog order.
 */
export function attribute(expected, actual) {
  const out = [];
  for (const f of FEATURES) {
    const a = f.detect(expected);
    const b = f.detect(actual);
    if (a !== b) out.push({ key: f.key, expected: a, actual: b });
  }
  return out;
}
