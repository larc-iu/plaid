// The "=" rule (R47): which side of a "=" is the clitic, its records and its
// reading over a word's chain. This reads a morpheme's stored metadata, which
// is why it sits beside the writers: what the rule may move is decided by what is
// stored, never by the type a morpheme goes by.
//
// Two records, both flat keys on the morpheme:
// - EQUALS_BEFORE_KEY (true) on the morpheme after a typed "=": the boundary
//   itself. It goes wherever that morpheme goes, so a split keeps it on the
//   left piece's boundary (the piece it is on keeps its metadata), a "=" typed
//   in the split puts it on the new piece after it, and a merge or a delete of
//   that morpheme takes it away with the boundary. An interior or blocked "="
//   stays recorded, and types its clitic once a change makes it outer or
//   frees its side.
// - EQUALS_TYPE_KEY (the type) beside a type the rule wrote: the type is the
//   rule's to move or clear only while the record names it, so a type a
//   person chose, an import, a model or another writer gave, or a linked
//   entry carries, is never touched.
//
// A "=" names a BOUNDARY (Leipzig rule 2: clitic boundary), but Plaid stores
// cliticness on the morpheme, so a fixed rule decides which side is the
// clitic: by position only, the first piece a proclitic, the last an
// enclitic, a two-piece word's last piece an enclitic, an interior boundary
// neither. The rule is read again over the whole word whenever its pieces
// change (a split, a merge, a delete, a "=" typed), so the outcome depends
// only on the chain, never on the order it was typed in. PolyGloss's writer
// in the Python client (workflows/igt/interlinear.py) applies the same rule.

// The key on the morpheme after a typed "=", and its reading, are plaid-ui's:
// every app's joiner reads them (morphemeJoiner). By relative path, so this
// file still loads under plain node.
import { EQUALS_BEFORE_KEY, equalsBefore } from '../../../../plaid-ui/src/domain/morphemes.js';

export { EQUALS_BEFORE_KEY };

/**
 * Which side of the "=" boundary after morpheme `leftIdx` (0-based, in a word
 * of `count` morphemes) is the clitic: 'left' | 'right' | null.
 */
export const cliticSideOfBoundary = ({ leftIdx, count }) => {
  const leftIsFirst = leftIdx === 0;
  const rightIsLast = leftIdx + 1 === count - 1;
  if (rightIsLast) return 'right';
  return leftIsFirst ? 'left' : null;
};

/** The type the rule gives the clitic on each side. */
const CLITIC_TYPE_BY_SIDE = Object.freeze({ left: 'proclitic', right: 'enclitic' });

/** The key that records a type the rule wrote, holding that type. */
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
 * The typed "=" boundaries of a word's chain, read off the keys: a set of
 * boundary indices (boundary b lies between pieces b and b + 1). `pieces` are
 * the word's morphemes in order, each `{ metadata, entryType }`. A key on the
 * first piece stands before nothing.
 */
export const equalsBoundaries = (pieces) => {
  const out = new Set();
  pieces.forEach((p, k) => {
    if (k > 0 && equalsBefore(p.metadata)) out.add(k - 1);
  });
  return out;
};

/** The piece the rule types for boundary `b` of a `count`-piece word, or null. */
const cliticOfBoundary = (b, count) => {
  const side = cliticSideOfBoundary({ leftIdx: b, count });
  return side === 'left' ? b : side === 'right' ? b + 1 : null;
};

/**
 * What the rule writes on each piece of a chain, from the "=" boundaries its
 * keys record: per piece, null for no change, or the metadata to merge (a null
 * value takes the key away). A piece that goes by a type the rule did not set
 * is left as it is, and the side it would have taken stays untyped. A key on
 * the first piece is taken away.
 */
export const rereadEquals = (pieces) => {
  const want = pieces.map(() => null);
  equalsBoundaries(pieces).forEach((b) => {
    const k = cliticOfBoundary(b, pieces.length);
    if (k != null) want[k] = CLITIC_TYPE_BY_SIDE[k === b ? 'left' : 'right'];
  });
  return pieces.map((p, k) => {
    const change = k === 0 && equalsBefore(p.metadata) ? { [EQUALS_BEFORE_KEY]: null } : {};
    const own = p.metadata?.morphType;
    const byRule = typedByEquals(p.metadata, p.entryType);
    const free = byRule || (!isType(own) && !isType(p.entryType));
    if (free && (byRule ? own : null) !== want[k]) {
      Object.assign(
        change,
        want[k]
          ? { morphType: want[k], [EQUALS_TYPE_KEY]: want[k] }
          : { morphType: null, [EQUALS_TYPE_KEY]: null },
      );
    }
    return Object.keys(change).length ? change : null;
  });
};

/**
 * The typed "=" boundaries whose clitic is piece `k` of the chain, as the keys
 * that record them: `[pieceIndex]` of each morpheme to take the key from.
 * Clearing a clitic's type takes back the "=" that typed it.
 */
export const equalsOfClitic = (pieces, k) =>
  [...equalsBoundaries(pieces)]
    .filter((b) => cliticOfBoundary(b, pieces.length) === k)
    .map((b) => b + 1);

/**
 * The records an analysis copy carries with a morpheme's type: the key before
 * it, and the rule's record while it names the type the morpheme holds.
 */
export const equalsRecords = (metadata) => ({
  ...(equalsBefore(metadata) ? { [EQUALS_BEFORE_KEY]: true } : {}),
  ...(typedByEquals(metadata) ? { [EQUALS_TYPE_KEY]: metadata[EQUALS_TYPE_KEY] } : {}),
});

/**
 * A chain written whole by a writer that reads "=" boundaries (an importer):
 * `befores` says, per piece, whether a "=" stands before it. Per piece, the
 * type the rule gives (or null) and the records typing it in the grid leaves
 * (`equals`, absent when there are none).
 */
export const equalsChain = (befores) => {
  const pieces = befores.map((b) => ({ metadata: b ? { [EQUALS_BEFORE_KEY]: true } : {} }));
  return rereadEquals(pieces).map((change, k) => {
    const equals = {
      ...(k > 0 && befores[k] ? { [EQUALS_BEFORE_KEY]: true } : {}),
      ...(change?.morphType ? { [EQUALS_TYPE_KEY]: change.morphType } : {}),
    };
    return {
      morphType: change?.morphType ?? null,
      ...(Object.keys(equals).length ? { equals } : {}),
    };
  });
};
