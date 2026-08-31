// Matching a known word form against a position in a baseline string.
//
// Shared by the importers that are handed an ORDERED list of word forms with
// no character offsets and have to re-derive them: FLEx segments
// (flex/buildDocuments.js) and CLDF's Analyzed_Word (cldf/buildDocuments.js).
// Matching is case-folded because a stored form routinely differs in case from
// the surface it came from (the text says "За", the analysis stores "за").

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
