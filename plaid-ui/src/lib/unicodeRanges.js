// Tables of code-point ranges, as the Unicode generators write them: one
// packed string (`unpackRanges`), and the lookup (`inRanges`).
//
// No imports: plaid-umr's node suite reaches this file by relative path.

/**
 * `packed`, space-separated hex ranges (`30-39`, or `aa` for one code point),
 * as inclusive `[first, last]` pairs, in order.
 */
export const unpackRanges = (packed) =>
  packed.split(' ').map((r) => {
    const [a, b = a] = r.split('-');
    return [parseInt(a, 16), parseInt(b, 16)];
  });

/** Whether the first code point of `c` falls in `ranges` (sorted, apart). */
export const inRanges = (ranges, c) => {
  const cp = c.codePointAt(0);
  if (cp === undefined) return false;
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cp < ranges[mid][0]) hi = mid - 1;
    else if (cp > ranges[mid][1]) lo = mid + 1;
    else return true;
  }
  return false;
};
