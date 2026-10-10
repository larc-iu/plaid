// What the Unicode range generators share (plaid-umr's tools/letterClasses.mjs,
// plaid-igt's tools/punctuationClasses.mjs): the pin, the ranges a pattern
// matches, and the packed string plaid-ui's src/lib/unicodeRanges.js reads back.

/**
 * Stops the run unless this node's Unicode is `pinned`. Moving a pin is a
 * deliberate change: run the generator with a node whose
 * `process.versions.unicode` is the new one, and set it there.
 */
export const requireUnicode = (pinned) => {
  if (process.versions.unicode !== pinned) {
    console.error(
      `This node has Unicode ${process.versions.unicode}, and the tables are pinned to ${pinned}.`,
    );
    process.exit(1);
  }
};

/** The code points `re` matches, as inclusive `[first, last]` ranges, in order. */
export const rangesOf = (re) => {
  const out = [];
  for (let cp = 0; cp <= 0x10ffff; cp++) {
    if (!re.test(String.fromCodePoint(cp))) continue;
    const last = out[out.length - 1];
    if (last && last[1] === cp - 1) last[1] = cp;
    else out.push([cp, cp]);
  }
  return out;
};

/** `ranges` as one string of space-separated hex ranges (`unpackRanges`). */
export const packRanges = (ranges) =>
  ranges
    .map(([a, b]) => (a === b ? a.toString(16) : `${a.toString(16)}-${b.toString(16)}`))
    .join(' ');
