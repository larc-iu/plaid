// Where a morpheme sits inside its written word, for marking it in a sentence
// (the dictionary's concordance and examples, GH #68). A fixed rule with no
// guessing:
//
// The WRITTEN form is the word token's stretch of the baseline text (a derived
// token's `content`). A morpheme's FORM is what the Analyze grid shows in its
// form cell (`morphFormOf`: `metadata.form`, else the word's text). Both are
// read composed (NFC), and each form is composed on its own. The forms are
// walked against the written word in order, code point by code point, and
// each morpheme owns the stretch its form spells, when the walk ends exactly
// at the word's end. Two allowances, and no others:
// - a letter may differ from the written one in case only (`toLowerCase` of
//   each code point, which must stay one code point on both sides);
// - between two morphemes, never at the word's start or end, the written word
//   may hold one joint the app draws ("-" or "="), which belongs to neither.
//   Only where the next form does not spell on from there: a form carrying
//   the character owns it.
// Anything else (an underlying form, a zero morph, a fused form) means no
// morpheme has a place in the written word. The letters are never searched
// for, since a short affix can occur twice or match part of the stem, and a
// wrong mark is worse than none.

import { morphFormOf } from './igtExport.js';
import { equalsBefore, shownMorphemeJoiner } from './affixMarkers.js';

const cps = (s) => [...(s ?? '').normalize('NFC')];

// The joints shownMorphemeJoiner draws, without its hair space. The app takes
// no other character as a joint (U+2010 and U+2011 are not split on).
const JOINTS = new Set(['-', '=']);

const lowerOne = (c) => {
  const l = c.toLowerCase();
  return [...l].length === 1 ? l : null;
};
const sameLetter = (a, b) => a === b || (lowerOne(a) !== null && lowerOne(a) === lowerOne(b));

const spellsAt = (written, form, at) =>
  at + form.length <= written.length && form.every((c, i) => sameLetter(c, written[at + i]));

// Each morpheme's start in the written word, or null when the forms do not
// spell it.
const startsIn = (written, forms) => {
  const starts = [];
  let pos = 0;
  for (let i = 0; i < forms.length; i++) {
    if (!spellsAt(written, forms[i], pos)) {
      const skip = i > 0 && JOINTS.has(written[pos]) && spellsAt(written, forms[i], pos + 1);
      if (!skip) return null;
      pos += 1;
    }
    starts.push(pos);
    pos += forms[i].length;
  }
  return pos === written.length ? starts : null;
};

/**
 * The code-point range `{ begin, end }` of `morpheme` within `word`'s written
 * form, or null when the word's forms do not spell it (see above), when the
 * morpheme is not one of the word's, or when its form is empty.
 */
export function morphemeRangeInWord(word, morpheme) {
  const morphemes = word?.morphemes || [];
  const index = morphemes.findIndex((m) => m === morpheme || (m.id && m.id === morpheme?.id));
  if (index < 0) return null;
  const forms = morphemes.map((m) => cps(morphFormOf(m)));
  const starts = startsIn(cps(word.content), forms);
  if (!starts || !forms[index].length) return null;
  return { begin: starts[index], end: starts[index] + forms[index].length };
}

/**
 * The word's segmentation as the Analyze grid draws it: each morpheme's form
 * with the joint before it (null before the first, "-" or "=" placed as the
 * grid places it), and whether it is one of `hitIds`.
 */
export const segmentationParts = (word, hitIds) => {
  const morphemes = word?.morphemes || [];
  return morphemes.map((m, i) => ({
    joiner:
      i > 0
        ? shownMorphemeJoiner(morphemes[i - 1].morphType, m.morphType, equalsBefore(m.metadata))
        : null,
    form: morphFormOf(m),
    hit: hitIds.has(m.id),
  }));
};
