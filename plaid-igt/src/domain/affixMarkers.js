// Affix-attachment markers for morpheme chains, rendered at display time in
// NON-editable contexts only (island rest view, Copy-as-IGT). Markers are
// never stored in the baseline text or in morpheme forms.
//
// Rule (deliberately simple): a clitic attaches to its neighbor with "=",
// everything else with "-". A morpheme's kind comes from metadata.morphType
// (the FLEx morph-type name stamped by the .fwbackup importer, e.g. "stem",
// "suffix", "enclitic"); morphemes without one — every hand-entered morpheme —
// get the "-" default.

export const isClitic = (morphType) =>
  typeof morphType === 'string' && morphType.toLowerCase().includes('clitic');

/**
 * The joint between two adjacent morphemes in a word, given their
 * metadata.morphType values: "=" when either side is a clitic, else "-".
 */
export const morphemeJoiner = (prevMorphType, morphType) =>
  isClitic(prevMorphType) || isClitic(morphType) ? '=' : '-';

/** Join morpheme strings with per-pair joints. items: [{text, morphType}] */
export const joinMorphemes = (items) =>
  items.map((m, i) => (i === 0 ? m.text : morphemeJoiner(items[i - 1].morphType, m.morphType) + m.text)).join('');
