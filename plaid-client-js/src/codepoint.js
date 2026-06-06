/**
 * Unicode code-point helpers for working with Plaid text offsets.
 *
 * Plaid token offsets (`begin` / `end`) are 0-based indices in Unicode CODE
 * POINTS (begin inclusive, end exclusive) — NOT UTF-16 code units. JavaScript
 * strings are UTF-16, so `.length`, `.slice`, `.substring`, `s[i]`,
 * `String.prototype.indexOf`, and `Intl.Segmenter`'s `index` all count UTF-16
 * code units, which disagree with code points for astral characters
 * (>= U+10000 — emoji, and SMP scripts such as Gothic, cuneiform, CJK Ext-B).
 *
 * Use these to slice a text body by token offsets, and to compute offsets for
 * new tokens, in code points. The spread/`for…of` string iterator yields code
 * points, which is what makes this work.
 */

/** Number of Unicode code points in `s` (not `s.length`, which is UTF-16). */
export function cpLength(s) {
  return [...s].length;
}

/**
 * Substring of `s` by CODE-POINT indices [begin, end) (end optional = to end).
 * Mirrors `String.prototype.slice` semantics but in code points.
 */
export function cpSlice(s, begin, end) {
  return [...s].slice(begin, end).join('');
}

/**
 * Convert a UTF-16 index `u` into `s` to a code-point index — i.e. how many
 * code points precede `u`. Inverse of `cpToUtf16`. Useful for converting a
 * DOM/`indexOf`/`Intl.Segmenter` (UTF-16) position into a code-point offset.
 */
export function utf16ToCp(s, u) {
  return [...s.slice(0, u)].length;
}

/**
 * Convert a code-point index `cp` into `s` to a UTF-16 index. Clamps to
 * `s.length` when `cp` is past the end. Inverse of `utf16ToCp`.
 */
export function cpToUtf16(s, cp) {
  if (cp <= 0) return 0;
  let u = 0;
  let c = 0;
  for (const ch of s) {
    if (c >= cp) break;
    u += ch.length; // 1 for BMP, 2 for an astral code point (surrogate pair)
    c += 1;
  }
  return u;
}

/**
 * Like `String.prototype.indexOf`, but the returned index and `fromCp` are
 * CODE-POINT indices. Returns -1 when `sub` is not found.
 */
export function cpIndexOf(s, sub, fromCp = 0) {
  const u = s.indexOf(sub, cpToUtf16(s, fromCp));
  return u < 0 ? -1 : utf16ToCp(s, u);
}
