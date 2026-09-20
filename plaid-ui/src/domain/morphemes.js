// How a chain of morphemes is written out, shared by every app that draws
// one. plaid-igt owns the morph-type inventory and everything about talking
// to FieldWorks (see its `domain/affixMarkers.js`, which re-exports these);
// what lives here is only the part another app needs to render a word.
//
// A morpheme's kind is `metadata.morphType`, the FLEx morph-type name a
// .fwbackup import stamps ('stem', 'suffix', 'enclitic'). A hand-entered
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
