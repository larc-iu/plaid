// The "=" rule's record and its reading over a word's chain (R47). The rule
// itself, which side of a "=" is the clitic, is affixMarkers.js's
// cliticSideOfBoundary. This reads a morpheme's stored type, which is why it
// sits beside the writers: what the rule may move is decided by what is
// stored, never by the type a morpheme goes by.
import { CLITIC_TYPE_BY_SIDE, cliticSideOfBoundary } from '../affixMarkers.js';

/**
 * The morpheme metadata key that records a type "=" set: it holds the type
 * the rule wrote. The rule moves or clears only a type whose record names it,
 * so a type a person chose, an import or a model gave, or another writer put
 * over the rule's own, is never touched, and a type is never read as the
 * rule's from its value alone.
 */
export const EQUALS_TYPE_KEY = 'morphTypeFromEquals';

const isType = (t) => typeof t === 'string' && t !== '';

/**
 * Did "=" set the type this morpheme goes by? `entryType` is its linked
 * entry's type (null when it is linked to none or the entry has none): a
 * morpheme goes by that one, which the rule never sets.
 */
export const typedByEquals = (metadata, entryType = null) =>
  !isType(entryType) &&
  isType(metadata?.[EQUALS_TYPE_KEY]) &&
  metadata[EQUALS_TYPE_KEY] === metadata.morphType;

/**
 * The "=" boundaries a word's chain records, read off the types "=" set: a
 * proclitic the rule typed has its "=" after it, an enclitic before it.
 * `pieces` are the word's morphemes in order, each `{ metadata, entryType }`.
 * A set of boundary indices (boundary b lies between pieces b and b + 1).
 */
export const equalsBoundaries = (pieces) => {
  const out = new Set();
  pieces.forEach((p, k) => {
    if (!typedByEquals(p.metadata, p.entryType)) return;
    const t = p.metadata.morphType;
    if (t === 'proclitic' && k < pieces.length - 1) out.add(k);
    if (t === 'enclitic' && k > 0) out.add(k - 1);
  });
  return out;
};

/** The boundaries once piece `at` is split, `joiners` between its new pieces. */
export const equalsAfterSplit = (boundaries, at, joiners) => {
  const out = new Set();
  boundaries.forEach((b) => out.add(b < at ? b : b + joiners.length));
  joiners.forEach((j, i) => {
    if (j === '=') out.add(at + i);
  });
  return out;
};

/**
 * The boundaries once piece `at` is gone, merged into the piece before it or
 * deleted: the boundary before it goes with it (after it, for the first).
 */
export const equalsAfterRemove = (boundaries, at) => {
  const gone = at > 0 ? at - 1 : 0;
  const out = new Set();
  boundaries.forEach((b) => {
    if (b !== gone) out.add(b > gone ? b - 1 : b);
  });
  return out;
};

/**
 * What the rule writes on each piece of a chain whose "=" boundaries are
 * `boundaries`: per piece, null for no change, or the metadata to merge
 * (`{ morphType, [EQUALS_TYPE_KEY] }`, a null value taking the key away).
 * A piece that goes by a type the rule did not set is left as it is, and
 * then the side it would have taken stays untyped.
 */
export const rereadEquals = (pieces, boundaries) => {
  const want = pieces.map(() => null);
  boundaries.forEach((b) => {
    const side = cliticSideOfBoundary({ leftIdx: b, count: pieces.length });
    if (!side) return;
    want[side === 'left' ? b : b + 1] = CLITIC_TYPE_BY_SIDE[side];
  });
  return pieces.map((p, k) => {
    const own = p.metadata?.morphType;
    const byRule = typedByEquals(p.metadata, p.entryType);
    if (!byRule && (isType(own) || isType(p.entryType))) return null;
    const now = byRule ? own : null;
    if (now === want[k]) return null;
    return want[k]
      ? { morphType: want[k], [EQUALS_TYPE_KEY]: want[k] }
      : { morphType: null, [EQUALS_TYPE_KEY]: null };
  });
};
