// A built ELAN document's sentence as interlinear rows, for the review step.
//
// The tier rows say where each tier goes and the counts say how much there is,
// but only the lines themselves say whether the mapping is RIGHT: a gloss tier
// mapped as a word field, a morpheme tier left off, or a corpus whose morph
// tier is there and empty, all read correctly as numbers and wrongly at a
// glance. This is the same sentence the import would write, laid out the way
// the Analyze tab will show it.

import { joinMorphemes } from '@/domain/affixMarkers';
import { isOrthographyKey, orthographyName } from '@/domain/igtConfig';
import { t } from '@ui/lib/i18n.js';

const textOf = (chars, span) => chars.slice(span.begin, span.end).join('');

// First-seen order across the sentence's words, which is the order the
// builder met the tiers in.
const namesIn = (maps) => {
  const seen = [];
  for (const map of maps) {
    for (const name of Object.keys(map || {})) if (!seen.includes(name)) seen.push(name);
  }
  return seen;
};

const joined = (morphemes, texts) =>
  texts.some((t) => (t ?? '') !== '')
    ? joinMorphemes(texts.map((text, i) => ({ text, morphType: morphemes[i].morphType })))
    : '';

/**
 * @param doc    one of buildElanDocuments' documents
 * @param index  which sentence
 * @returns {{
 *   words: string[],
 *   rows: Array<{kind: 'orthography'|'word'|'morphemes'|'morpheme', label: string, cells: string[]}>,
 *   unanalyzed: boolean[],
 *   fields: Array<[string, string]>,
 * }|null}  null when the document has no such sentence
 */
export function previewSentence(doc, index = 0) {
  const sentence = doc?.sentences?.[index];
  if (!sentence) return null;
  const chars = [...(doc.body ?? '')];
  const words = (doc.words || []).filter((w) => w.sentenceIndex === index);

  const wordFieldNames = namesIn(words.map((w) => w.fields));
  const rows = [];
  for (const name of wordFieldNames.filter((n) => isOrthographyKey(n))) {
    rows.push({
      kind: 'orthography',
      label: orthographyName(name),
      cells: words.map((w) => w.fields?.[name] ?? ''),
    });
  }
  for (const name of wordFieldNames.filter((n) => !isOrthographyKey(n))) {
    rows.push({ kind: 'word', label: name, cells: words.map((w) => w.fields?.[name] ?? '') });
  }

  // A word the source never segmented has no morphemes, and reads as itself.
  const unanalyzed = words.map((w) => !(w.morphemes || []).length);
  const anyMorphemes = unanalyzed.some((u) => !u);
  if (anyMorphemes) {
    rows.push({
      kind: 'morphemes',
      label: t('Morphemes'),
      cells: words.map((w, i) =>
        unanalyzed[i]
          ? textOf(chars, w)
          : joined(
              w.morphemes,
              // A sole morpheme with no form of its own shows the word's.
              w.morphemes.map((m) => m.form ?? textOf(chars, w)),
            ),
      ),
    });
    const morphFieldNames = namesIn(words.flatMap((w) => (w.morphemes || []).map((m) => m.fields)));
    for (const name of morphFieldNames) {
      rows.push({
        kind: 'morpheme',
        label: name,
        cells: words.map((w) =>
          (w.morphemes || []).length
            ? joined(
                w.morphemes,
                w.morphemes.map((m) => m.fields?.[name] ?? ''),
              )
            : '',
        ),
      });
    }
  }

  return {
    words: words.map((w) => textOf(chars, w)),
    rows,
    unanalyzed: anyMorphemes ? unanalyzed : words.map(() => false),
    fields: Object.entries(sentence.fields || {}).filter(([, v]) => (v ?? '') !== ''),
  };
}

/** The batch in numbers, for the line beside the Import button. */
export const elanCounts = (build) => {
  if (!build) return '';
  const { stats } = build;
  // Each count is its own phrase, and `{n}` inside the plural writes the
  // number as it is, with no grouping.
  return [
    t('{n, plural, one {{n} document} other {{n} documents}}', { n: build.documents.length }),
    t('{n, plural, one {{n} sentence} other {{n} sentences}}', { n: stats.sentences }),
    t('{n, plural, one {{n} word} other {{n} words}}', { n: stats.words }),
    stats.morphemes
      ? t('{n, plural, one {{n} morpheme} other {{n} morphemes}}', { n: stats.morphemes })
      : null,
    stats.alignments
      ? t('{n, plural, one {{n} time-aligned segment} other {{n} time-aligned segments}}', {
          n: stats.alignments,
        })
      : null,
    stats.speakers.length ? t('speakers: {names}', { names: stats.speakers.join(', ') }) : null,
  ]
    .filter(Boolean)
    .join(' · ');
};
