import { t } from '@ui/lib/i18n.js';

// What Auto-analyze's service steps say, from the counts the services report
// (the core manual, "Service results"). Each step gives its parts, lower-case
// clauses the dialog joins into one toast with the other steps', and whether
// it wrote anything. The same parts word a step rejoined after a reload
// (analyzeNotice, translateNotice), so the two say the same thing (R18).
//
// Pure, so analyzeNotice.test.js can drive every shape.

const count = (n) => (Number.isInteger(n) && n > 0 ? n : 0);

// What a service could not do. Services report per-sentence failures in the
// result rather than failing the request, and the sentences never sent once
// the model stopped answering in `sentencesNotAsked`.
// `couldNot` words the first, for the step's own verb.
const failureParts = (result, couldNot) => {
  const failed = Array.isArray(result?.sentencesFailed) ? result.sentencesFailed.length : 0;
  const notAsked = Array.isArray(result?.sentencesNotAsked) ? result.sentencesNotAsked.length : 0;
  return [
    ...(failed ? [couldNot(failed)] : []),
    ...(notAsked
      ? [
          t(
            'stopped early: the model did not answer ({n, plural, one {# sentence} other {# sentences}} not asked)',
            { n: notAsked },
          ),
        ]
      : []),
  ];
};

export const translateParts = (result) => {
  const written = count(result?.sentencesWritten);
  return {
    wrote: written > 0,
    parts: [
      ...(written
        ? [
            t('proposed translations for {n, plural, one {# sentence} other {# sentences}}', {
              n: written,
            }),
          ]
        : []),
      ...failureParts(result, (n) =>
        t('could not translate {n, plural, one {# sentence} other {# sentences}}', { n }),
      ),
      // A field the service reads only for context, and went on without.
      ...(result?.glossFieldMissing
        ? [t('read no glosses (no morpheme field “{name}”)', { name: result.glossFieldMissing })]
        : []),
    ],
  };
};

export const analyzeParts = (result) => {
  const written = count(result?.wordsWritten);
  const kept = count(result?.skipped?.protected);
  const unaligned = count(result?.skipped?.unaligned);
  return {
    wrote: written > 0,
    parts: [
      ...(written
        ? [t('proposed analyses for {n, plural, one {# word} other {# words}}', { n: written })]
        : []),
      ...(kept
        ? [
            t(
              'left {n, plural, one {# word} other {# words}} with a person’s morphemes or morpheme glosses alone (“Overwrite human-edited annotations” replaces them)',
              { n: kept },
            ),
          ]
        : []),
      ...(unaligned
        ? [t('got no analysis for {n, plural, one {# word} other {# words}}', { n: unaligned })]
        : []),
      ...failureParts(result, (n) =>
        t('could not analyze {n, plural, one {# sentence} other {# sentences}}', { n }),
      ),
      ...(result?.translationFieldMissing
        ? [
            t('read no translations (no sentence field “{name}”)', {
              name: result.translationFieldMissing,
            }),
          ]
        : []),
    ],
  };
};

// The one toast for the parts of every step that ran. The violet line is a
// promise about material on screen, so it is only made when something was
// written.
export const partsNotice = ({ parts, wrote }) => {
  // The clauses are a list of their own messages, so the join stays here.
  const joined = `${parts.join(', ')}.`; // i18n-ignore: punctuation joining whole clauses
  const text = parts.length
    ? wrote
      ? `${joined} ${t('Shown in violet until confirmed.')}`
      : joined
    : t('Nothing new to apply.');
  return {
    level: wrote ? 'success' : 'warning',
    title: t('Auto-analyze'),
    message: text.charAt(0).toUpperCase() + text.slice(1),
  };
};

export const translateNotice = (result) => partsNotice(translateParts(result));
export const analyzeNotice = (result) => partsNotice(analyzeParts(result));
