// How a chain of morphemes is written out, shared by every app that draws
// one. plaid-igt owns the morph-type inventory and everything about talking
// to FieldWorks (see its `domain/affixMarkers.js`, which re-exports these);
// what lives here is only the part another app needs to render a word.
//
// A morpheme's kind is a FLEx morph-type name ('stem', 'suffix',
// 'enclitic'): its linked lexicon entry's when that entry goes by one, else
// its own `metadata.morphType` (`morphemeMorphType` below). A hand-entered
// morpheme has none, and takes the default.

/** Is this morph type a clitic of any kind (clitic, enclitic, proclitic)? */
export const isClitic = (morphType) =>
  typeof morphType === 'string' && morphType.toLowerCase().includes('clitic');

/**
 * The joint between two adjacent morphemes of a word, from their
 * `metadata.morphType` values: "=" when either side is a clitic, else "-".
 *
 * Deliberately simple, and rendered at DISPLAY time only: a marker is never
 * stored in the baseline text or in a morpheme's form, and an exported file
 * writes the forms bare.
 */
export const morphemeJoiner = (prevMorphType, morphType) =>
  isClitic(prevMorphType) || isClitic(morphType) ? '=' : '-';

const isType = (t) => typeof t === 'string' && t !== '';

/**
 * The morph type lexicon entry `id` goes by: its own, else the nearest
 * ancestor's in its sense tree. A sense made by hand carries none of its own,
 * and it is the same morph as its headword. `typeOf(id)` is an entry's own
 * `metadata.morphType`, `parentOf(id)` its headword's id or null. Null when
 * no entry on the chain has one.
 */
export const entryMorphType = (id, typeOf, parentOf) => {
  let cur = id;
  const seen = new Set();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const t = typeOf(cur);
    if (isType(t)) return t;
    cur = parentOf(cur) ?? null;
  }
  return null;
};

/**
 * The morph type a morpheme goes by: its linked entry's (`entryType`, what
 * `entryMorphType` answers for it, null when it is linked to none or the
 * entry goes by none), else its own `metadata.morphType`. A linked morpheme
 * stores no copy of its entry's type, so every reader asks this.
 */
export const morphemeMorphType = (metadata, entryType = null) => {
  if (isType(entryType)) return entryType;
  return isType(metadata?.morphType) ? metadata.morphType : null;
};
