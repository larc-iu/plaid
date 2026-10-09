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
 * Prebuilt slicer for taking MANY code-point slices of the same string:
 * spreads `s` into code points once, then each slice costs O(slice length).
 * `cpSlice` spreads the whole string per call, which turns quadratic when a
 * caller slices every token of a large text. Mirror of the server's
 * `plaid.util.codepoint/cp-slicer`.
 */
export function cpSlicer(s) {
  const chars = [...(s ?? '')];
  return (begin, end) => chars.slice(begin, end).join('');
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

const MARK = /^\p{M}$/u;

// The longest piece whose inside positions are each placed where cutting
// there leaves the composed text as it is (core's `refine-limit`).
const REFINE_LIMIT = 32;

// The positions strictly inside the piece [b, e) of `cps`, which composed to
// `c` (`len` code points) at `out`: a place where the piece's two halves
// compose apart to `c` goes to the end of the first half (a tone mark that
// does not compose with ẹ stays out of it), any other to the next such place,
// else to the piece's end. Mirror of core's `refine-inside!`.
function refineInside(at, cps, b, e, out, c, len) {
  const whole = e - b > REFINE_LIMIT;
  let next = out + len;
  for (let i = e - 1; i > b; i -= 1) {
    if (!whole) {
      const pre = cps.slice(b, i).join('').normalize('NFC');
      if (pre + cps.slice(i, e).join('').normalize('NFC') === c) {
        next = Math.min(next, out + [...pre].length);
      }
    }
    at[i] = next;
  }
}

/**
 * `s` composed (Unicode NFC), as the server stores every text, and where each
 * code-point position of `s` goes in it: `{ text, at }`, `at(p)` for every p
 * in [0, cpLength(s)]. Mirror of the server's `plaid.util.canonical/compose`,
 * for an app that measures tokens on a body it is about to send: the server
 * stores `text`, and a token measured at [b, e) on `s` is at [at(b), at(e)).
 *
 * `s` is cut before each code point that is not a mark, a piece joined to the
 * one before when the two compose together (Hangul jamo, a vowel sign), and
 * each piece composes on its own. A position inside a piece composing changed
 * goes to where cutting the piece there composes the same, else to the next
 * such place, at the latest the piece's composed end, so an edge between a
 * letter and the mark that composes with it moves to after the composed
 * character, and a mark that does not compose stays out of it. `at` never
 * reverses two positions.
 */
export function composeText(s) {
  const text0 = s ?? '';
  if (text0.normalize('NFC') === text0) return { text: text0, at: (p) => p };
  const cps = [...text0];
  const n = cps.length;
  const pieces = [];
  let start = 0;
  for (let i = 1; i <= n; i += 1) {
    if (i < n && MARK.test(cps[i])) continue;
    const last = pieces[pieces.length - 1];
    if (last && cps[start].codePointAt(0) >= 0x300) {
      const a = cps.slice(last[0], last[1]).join('');
      const b = cps.slice(start, i).join('');
      if ((a + b).normalize('NFC') !== a.normalize('NFC') + b.normalize('NFC')) {
        last[1] = i;
        start = i;
        continue;
      }
    }
    pieces.push([start, i]);
    start = i;
  }
  const at = new Int32Array(n + 1);
  let text = '';
  let out = 0;
  for (const [b, e] of pieces) {
    const src = cps.slice(b, e).join('');
    const c = src.normalize('NFC');
    const len = [...c].length;
    text += c;
    if (c === src) {
      for (let i = b; i < e; i += 1) at[i] = out + (i - b);
    } else {
      at[b] = out;
      refineInside(at, cps, b, e, out, c, len);
    }
    out += len;
  }
  at[n] = out;
  if (text !== text0.normalize('NFC')) throw new Error('The text could not be composed.');
  return { text, at: (p) => at[p] };
}
