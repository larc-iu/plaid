// Affix-attachment markers for morpheme chains, rendered at display time in
// NON-editable contexts only (island rest view, Copy-as-IGT). Markers are
// never stored in the baseline text or in morpheme forms.
//
// Rule (deliberately simple): a clitic attaches to its neighbor with "=",
// everything else with "-". A morpheme's kind comes from metadata.morphType
// (the FLEx morph-type name stamped by the .fwbackup importer, e.g. "stem",
// "suffix", "enclitic"); morphemes without one — every hand-entered morpheme —
// get the "-" default.

// FLEx's exact morph-type inventory (MoMorphType names), the controlled
// vocabulary for metadata.morphType everywhere it's editable, and each type's
// affix markers, live in the client beside the entry-form rule (lexicon entry
// forms are stored without markers), so the agent's Python copy reads the
// same table. Re-exported, so this file stays the one place morph types are
// reasoned about here.
import {
  MORPH_TYPES as FLEX_MORPH_TYPES,
  decorateWithAffixMarkers,
  readAffixMarkers,
} from '@larc-iu/plaid-client';
export { FLEX_MORPH_TYPES, decorateWithAffixMarkers, readAffixMarkers };

/** Is this a storable morph type? (null/undefined = "no type" is also valid) */
export const isValidMorphType = (t) => t == null || FLEX_MORPH_TYPES.includes(t);

/**
 * What a morph type is called on screen. The stored values are FieldWorks'
 * own inventory (LIFT and .flextext need them verbatim), but "phrase" is
 * FieldWorks-speak: linguists say multi-word expression. FieldWorks' second
 * phrase type, "discontiguous phrase", is the same thing here (whether an
 * expression skips a word is plain from its words), so it shows under the
 * same name and is never offered as a choice, only kept when imported.
 */
export const morphTypeLabel = (t) =>
  t === 'phrase' || t === 'discontiguous phrase' ? 'multi-word expression' : t;

/** The types a select offers: the inventory, minus the one it never proposes. */
export const morphTypeOptions = (current = null) =>
  FLEX_MORPH_TYPES.filter((t) => t !== 'discontiguous phrase' || t === current);

// The two every app that draws a word needs live in the shared package, so
// plaid-umr's canvas joins a chain the same way this app's grid does rather
// than by a second copy of the rule. Re-exported, so this file stays the one
// place morph types are reasoned about here.
export { isClitic, morphemeJoiner } from '@ui/domain/morphemes.js';
import { isClitic, morphemeJoiner } from '@ui/domain/morphemes.js';
import { isZeroMorph } from './zeroMorph.js';

/**
 * Is this morph type a bound form (an affix or a clitic)? Bound forms only
 * occur as pieces of a word, so a whole-word token never links to one.
 */
export const isBoundType = (morphType) =>
  typeof morphType === 'string' && (isClitic(morphType) || /fix$/.test(morphType.toLowerCase()));

/**
 * Could a morpheme with this morph type and form name its word? Not an affix
 * or a clitic, not the zero morph and not a form emptied by hand. Its gloss
 * is read with the word's other such glosses, with the gloss rule's fall-back
 * (tagsets.js). The UMR skeleton asks the same (can_name_word).
 */
export const canNameWord = (morphType, form) =>
  !isBoundType(morphType) && !isZeroMorph(form) && typeof form === 'string' && form.trim() !== '';

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

const CLITIC_TYPE_BY_SIDE = Object.freeze({ left: 'proclitic', right: 'enclitic' });

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

// A value may arrive with the boundary already spelled out in it. CLDF writes
// its Gloss column that way (our own importer splits on those markers to find
// the morphemes, src/import/cldf/buildDocuments.js), ELAN's morph tiers do,
// and so does any lexicon whose glosses were written to Leipzig by hand. A
// joiner in front of such a value would be the second one.
const startsWithMarker = (text) => /^[-=]/.test(text ?? '');
const endsWithMarker = (text) => /[-=]$/.test(text ?? '');

/**
 * The joint to write between two adjacent pieces of a word: nothing when
 * either side already carries a marker on the edge that would meet it, else
 * the joiner their morph types call for. Suppressing ours rather than
 * stripping theirs keeps the value the author wrote, which is what a CLDF or
 * ELAN round trip reads back out.
 */
export const joinerBetween = (prev, next) =>
  endsWithMarker(prev?.text) || startsWithMarker(next?.text)
    ? ''
    : morphemeJoiner(prev?.morphType, next?.morphType);

/** Join morpheme strings with per-pair joints. items: [{text, morphType}] */
export const joinMorphemes = (items) =>
  items.map((m, i) => (i === 0 ? m.text : joinerBetween(items[i - 1], m) + m.text)).join('');
