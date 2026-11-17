// Where a morpheme sits inside its written word, for marking it in a sentence
// (the dictionary's concordance, GH #68). A fixed rule with no guessing:
//
// The WRITTEN form is the word token's stretch of the baseline text (a derived
// token's `content`). A morpheme's FORM is what the Analyze grid shows in its
// form cell (`morphFormOf`: `metadata.form`, else the word's text). When the
// word's forms, joined in order with nothing between them, are the written
// word exactly (both composed, NFC, no case folding), each morpheme owns the
// stretch its form spells. Otherwise no morpheme has a place in the written
// word: an underlying form, a zero morph, a fused form or a capital the form
// lacks all mean the written letters are not the forms'. The letters are never
// searched for in the word, since a short affix can occur twice or match part
// of the stem, and a wrong mark is worse than none.

import { cpLength } from '@larc-iu/plaid-client';
import { morphFormOf } from './igtExport.js';
import { equalsBefore, shownMorphemeJoiner } from './affixMarkers.js';

const nfc = (s) => (s ?? '').normalize('NFC');

/**
 * The code-point range `{ begin, end }` of `morpheme` within `word`'s written
 * form, or null when the word's forms do not spell it (see above), when the
 * morpheme is not one of the word's, or when its form is empty.
 *
 * Each form is composed on its own, so a letter that composes across a joint
 * (a stem's "e" and a suffix that is only an acute) spells nothing and gives
 * null rather than a range splitting the letter.
 */
export function morphemeRangeInWord(word, morpheme) {
  const morphemes = word?.morphemes || [];
  const index = morphemes.findIndex((m) => m === morpheme || (m.id && m.id === morpheme?.id));
  if (index < 0) return null;
  const forms = morphemes.map((m) => nfc(morphFormOf(m)));
  if (forms.join('') !== nfc(word.content)) return null;
  const begin = cpLength(forms.slice(0, index).join(''));
  const end = begin + cpLength(forms[index]);
  return end > begin ? { begin, end } : null;
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
