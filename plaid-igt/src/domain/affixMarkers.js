// Affix-attachment markers for morpheme chains, rendered at display time in
// NON-editable contexts only (island rest view, Copy-as-IGT). Markers are
// never stored in the baseline text or in morpheme forms.
//
// Rule (deliberately simple): a clitic attaches to its neighbor with "=",
// everything else with "-". A morpheme's kind comes from metadata.morphType
// (the FLEx morph-type name stamped by the .fwbackup importer, e.g. "stem",
// "suffix", "enclitic"); morphemes without one — every hand-entered morpheme —
// get the "-" default.

/**
 * FLEx's exact morph-type inventory (MoMorphType names), the controlled
 * vocabulary for metadata.morphType everywhere it's editable. Grouped:
 * stems/roots, affixes, clitics, other.
 */
export const FLEX_MORPH_TYPES = [
  'stem', 'bound stem', 'root', 'bound root',
  'prefix', 'suffix', 'infix', 'circumfix', 'simulfix', 'suprafix',
  'infixing interfix', 'prefixing interfix', 'suffixing interfix',
  'clitic', 'enclitic', 'proclitic',
  'particle', 'phrase', 'discontiguous phrase',
];

/** Is this a storable morph type? (null/undefined = "no type" is also valid) */
export const isValidMorphType = (t) => t == null || FLEX_MORPH_TYPES.includes(t);

export const isClitic = (morphType) =>
  typeof morphType === 'string' && morphType.toLowerCase().includes('clitic');

/** Is this morph type in the stem/root (lexical) group of the inventory? */
export const isStemType = (morphType) =>
  typeof morphType === 'string'
  && ['stem', 'bound stem', 'root', 'bound root'].includes(morphType.toLowerCase());

/**
 * The joint between two adjacent morphemes in a word, given their
 * metadata.morphType values: "=" when either side is a clitic, else "-".
 */
export const morphemeJoiner = (prevMorphType, morphType) =>
  isClitic(prevMorphType) || isClitic(morphType) ? '=' : '-';

/** Join morpheme strings with per-pair joints. items: [{text, morphType}] */
export const joinMorphemes = (items) =>
  items.map((m, i) => (i === 0 ? m.text : morphemeJoiner(items[i - 1].morphType, m.morphType) + m.text)).join('');
