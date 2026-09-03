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
  'stem',
  'bound stem',
  'root',
  'bound root',
  'prefix',
  'suffix',
  'infix',
  'circumfix',
  'simulfix',
  'suprafix',
  'infixing interfix',
  'prefixing interfix',
  'suffixing interfix',
  'clitic',
  'enclitic',
  'proclitic',
  'particle',
  'phrase',
  'discontiguous phrase',
];

/** Is this a storable morph type? (null/undefined = "no type" is also valid) */
export const isValidMorphType = (t) => t == null || FLEX_MORPH_TYPES.includes(t);

/**
 * What a morph type is called on screen. The stored values are FieldWorks'
 * own inventory (LIFT and .flextext need them verbatim), but "phrase" is
 * FieldWorks-speak: linguists say multi-word expression, so the two phrase
 * types are shown under that name.
 */
export const morphTypeLabel = (t) => {
  if (t === 'phrase') return 'multi-word expression';
  if (t === 'discontiguous phrase') return 'discontiguous multi-word expression';
  return t;
};

export const isClitic = (morphType) =>
  typeof morphType === 'string' && morphType.toLowerCase().includes('clitic');

/**
 * Is this morph type a bound form (an affix or a clitic)? Bound forms only
 * occur as pieces of a word, so a whole-word token never links to one.
 */
export const isBoundType = (morphType) =>
  typeof morphType === 'string' && (isClitic(morphType) || /fix$/.test(morphType.toLowerCase()));

/** Is this morph type in the stem/root (lexical) group of the inventory? */
export const isStemType = (morphType) =>
  typeof morphType === 'string' &&
  ['stem', 'bound stem', 'root', 'bound root'].includes(morphType.toLowerCase());

/**
 * The joint between two adjacent morphemes in a word, given their
 * metadata.morphType values: "=" when either side is a clitic, else "-".
 */
export const morphemeJoiner = (prevMorphType, morphType) =>
  isClitic(prevMorphType) || isClitic(morphType) ? '=' : '-';

// --- Per-type markers, for talking to FLEx ---------------------------------
// The Prefix/Postfix of each MoMorphType, read off the factory objects in real
// .fwbackup files (identical in Lezgi, Sena and Arabic, so they are constants
// and not per-project settings). The joiner rule above is what Plaid renders
// for a chain of morphemes. THIS is different: it is how FLEx spells one
// morpheme's form on its own, and FLEx compares decorated forms when it
// matches an imported morph against the lexicon, so an exporter that leaves
// the markers off matches nothing for any bound morph.
const MORPH_TYPE_MARKERS = {
  'bound root': ['*', ''],
  'bound stem': ['*', ''],
  enclitic: ['=', ''],
  infix: ['-', '-'],
  'infixing interfix': ['-', '-'],
  prefix: ['', '-'],
  'prefixing interfix': ['', '-'],
  proclitic: ['', '='],
  simulfix: ['=', '='],
  suffix: ['-', ''],
  'suffixing interfix': ['-', ''],
  suprafix: ['~', '~'],
};

/**
 * A morpheme form written the way FLEx writes it standing alone: "-ar" for a
 * suffix, "ka-" for a prefix, "=ni" for an enclitic, unchanged for a stem.
 * Mirrors DecorateFormWithAffixMarkers in FieldWorks' BIRDInterlinearImporter.
 * An unknown or absent type decorates nothing, which is right for the
 * hand-entered morphemes that have no type at all.
 */
export function decorateWithAffixMarkers(morphType, form) {
  if (form == null || form === '') return form;
  const marks = MORPH_TYPE_MARKERS[String(morphType ?? '').toLowerCase()];
  return marks ? `${marks[0]}${form}${marks[1]}` : form;
}

// --- Typing the clitic side of a "=" boundary ------------------------------
// A "=" names a BOUNDARY (Leipzig rule 2: clitic boundary), but Plaid stores
// cliticness on the morpheme, so something has to decide which side is the
// clitic. Same rule in the grid (typing "=") and in the PolyGloss service
// (which mirrors it in Python) so both agree.

// ALL-CAPS gloss = grammatical category label, hence the clitic side.
const isCapsGloss = (g) =>
  typeof g === 'string' && g !== '' && g === g.toUpperCase() && g !== g.toLowerCase();

/**
 * Which side of the "=" boundary after morpheme `leftIdx` (0-based, in a word
 * of `count` morphemes) is the clitic: 'left' | 'right' | null.
 * Positional rule first, since clitics sit outside the affixes: a boundary
 * whose left piece is the word's first morpheme makes it a proclitic, one whose
 * right piece is the last makes it an enclitic. When both hold (a two-morpheme
 * word) or neither (an interior boundary), gloss case decides if glosses are
 * known; failing that a two-morpheme word defaults to enclitic (by far the
 * commoner kind) and an interior boundary stays untyped.
 */
export const cliticSideOfBoundary = ({ leftIdx, count, leftGloss = null, rightGloss = null }) => {
  const leftIsFirst = leftIdx === 0;
  const rightIsLast = leftIdx + 1 === count - 1;
  if (leftIsFirst !== rightIsLast) return leftIsFirst ? 'left' : 'right';
  const lc = isCapsGloss(leftGloss);
  const rc = isCapsGloss(rightGloss);
  if (lc !== rc) return lc ? 'left' : 'right';
  return leftIsFirst && rightIsLast ? 'right' : null;
};

export const CLITIC_TYPE_BY_SIDE = Object.freeze({ left: 'proclitic', right: 'enclitic' });

/**
 * morphType stamps for a chain of pieces being written into a word.
 *   joiners  — one per boundary between consecutive pieces ('-' | '=')
 *   startIdx — 0-based index of the first piece in the word's final chain
 *   count    — morphemes in the word once the chain is in place
 *   types    — existing morphType per piece (null = untyped); only untyped
 *              pieces are ever stamped, an existing type is never overwritten
 *   glosses  — optional gloss per piece for the case tiebreak
 * Returns a new types array.
 */
export const cliticTypesForChain = ({ joiners, startIdx, count, types, glosses = [] }) => {
  const out = [...types];
  joiners.forEach((j, i) => {
    if (j !== '=') return;
    const side = cliticSideOfBoundary({
      leftIdx: startIdx + i,
      count,
      leftGloss: glosses[i] ?? null,
      rightGloss: glosses[i + 1] ?? null,
    });
    if (!side) return;
    const k = side === 'left' ? i : i + 1;
    if (out[k] == null) out[k] = CLITIC_TYPE_BY_SIDE[side];
  });
  return out;
};

/**
 * Parse pasted/typed chain text ("a-b=c") into { segments, joiners }: pieces
 * trimmed, empty pieces dropped (leading/trailing/doubled boundaries), each
 * joiner ('-' | '=') attached to the boundary before the piece that follows it.
 */
export const splitChainText = (text) => {
  const parts = (text ?? '').split(/([-=])/);
  const segments = [];
  const joiners = [];
  let pending = null;
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) {
      pending = parts[i];
      continue;
    }
    const seg = parts[i].trim();
    if (seg === '') continue;
    if (segments.length) joiners.push(pending ?? '-');
    segments.push(seg);
  }
  return { segments, joiners };
};

/** Join morpheme strings with per-pair joints. items: [{text, morphType}] */
export const joinMorphemes = (items) =>
  items
    .map((m, i) =>
      i === 0 ? m.text : morphemeJoiner(items[i - 1].morphType, m.morphType) + m.text,
    )
    .join('');
