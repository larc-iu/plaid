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

// One collator for every name sort: made once, since a sort compares
// thousands of times and `localeCompare` with options builds one per call.
const numericCollator = new Intl.Collator(undefined, { numeric: true });

/**
 * The order of DOCUMENT and PROJECT names wherever a list of them is sorted by
 * name. Projects number their texts in every shape ("(1) Frog story", "1.
 * Intro", "Text 1", "01_pear"), and a plain compare files "(10)" between "(1)"
 * and "(2)". This compares as `compareText` does, so a run of digits counts as
 * its number, in any script's digits. Names that compare equal ("02" and "2",
 * or two that differ only in case) fall back to the strings themselves, so the
 * order never depends on where a name started. A blank name is the smallest.
 *
 * Not for lexicon forms or vocabulary names: linguistic data keeps its own
 * order.
 */
export const compareNames = (a, b) => {
  const x = nfc(a);
  const y = nfc(b);
  const primary = numericCollator.compare(x.toLowerCase(), y.toLowerCase());
  if (primary !== 0) return primary;
  return x < y ? -1 : x > y ? 1 : 0;
};

/** Whether `query` occurs in `text`, either spelling of either one. */
export const textIncludes = (text, query) => collationKey(text).includes(collationKey(query));
