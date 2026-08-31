// Matching a known word form against a position in a baseline string.
//
// Shared by the importers that are handed an ORDERED list of word forms with
// no character offsets and have to re-derive them: FLEx segments
// (flex/buildDocuments.js) and CLDF's Analyzed_Word (cldf/buildDocuments.js).
// Matching is case-folded because a stored form routinely differs in case from
// the surface it came from (the text says "За", the analysis stores "за").

/**
 * A reusable UTF-16 index → code-point index converter for one string.
 *
 * The client's `utf16ToCp` is `[...s.slice(0, u)].length`, which allocates and
 * spreads the whole prefix on every call. That is fine once and quadratic when
 * called per token: on a 370KB document body it took ~19s of a 24s import.
 * Building the mapping once makes each lookup O(1).
 *
 * Most bodies have no astral characters at all, in which case the two indexes
 * coincide and no table is needed.
 *
 * An index inside a surrogate pair maps to the code point containing it. That
 * case does not arise from real token boundaries, which always fall between
 * code points.
 */
export function makeCpIndexer(s) {
  if (!/[\uD800-\uDFFF]/.test(s)) return (u) => Math.min(Math.max(u, 0), s.length);
  const map = new Int32Array(s.length + 1);
  let cp = 0;
  let u = 0;
  while (u < s.length) {
    const size = s.codePointAt(u) > 0xffff ? 2 : 1;
    for (let k = 0; k < size; k += 1) map[u + k] = cp;
    u += size;
    cp += 1;
  }
  map[s.length] = cp;
  return (at) => map[Math.min(Math.max(at, 0), s.length)];
}

/** Case-fold one code point; tolerates Turkish/Azeri dotted İ → i. */
export const foldChar = (c) => {
  const l = c.toLowerCase();
  return l === 'i̇' ? 'i' : l;
};

/**
 * Does `body` (at UTF-16 index `at`) case-foldedly start with `form`?
 * Returns the UTF-16 index just past the match, or false.
 */
export function matchesAt(body, at, form) {
  let i = at;
  for (const fc of form) {
    if (i >= body.length) return false;
    const bc = String.fromCodePoint(body.codePointAt(i));
    if (foldChar(bc) !== foldChar(fc)) return false;
    i += bc.length;
  }
  return i;
}
