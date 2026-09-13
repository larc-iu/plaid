// Comparing and filing user text: forms, headwords, glosses, search queries.
//
// Two things every caller needs and nothing gets right by accident.
//
// NORMALIZATION. `ẹ` can be written U+1EB9 or as `e` plus U+0323, and the two
// strings are not equal, do not compare alike, and do not match each other as
// substrings. Where they come from is out of anyone's hands: a keyboard layout,
// a FLEx export, a paste out of a PDF. So every string entering a comparison is
// put in NFC first, which is what the FLEx importer already forces on the way
// in.
//
// ORDER. Comparing with `<` is code-point order, which files every letter
// outside ASCII after `z`: a Yoruba lexicon listed `ẹja` and the seven `ọ`
// words below the end of the alphabet. `localeCompare` puts them back among
// the letters they belong with.
//
// This is the LOCALE's order, not a dictionary's own. A stated alphabet
// (n-graphs, a custom order) lives in `config.dict` and only plaid-dict honours
// it. Locale order is right for the overwhelming majority of scripts and is a
// great deal righter than code points.

/** A string in NFC. Null-safe, so a missing form reads as empty. */
export const nfc = (s) => String(s ?? '').normalize('NFC');

/**
 * What a string compares and matches AS: NFC, case dropped. One key serves
 * both the sort and the search box, so a list cannot order one way and filter
 * another.
 */
export const collationKey = (s) => nfc(s).toLowerCase();

/**
 * Alphabetical order for two pieces of user text. Numeric, so "a 10" follows
 * "a 9" rather than "a 1".
 */
export const compareText = (a, b) =>
  collationKey(a).localeCompare(collationKey(b), undefined, { numeric: true });

/** Whether `query` occurs in `text`, either spelling of either one. */
export const textIncludes = (text, query) => collationKey(text).includes(collationKey(query));
