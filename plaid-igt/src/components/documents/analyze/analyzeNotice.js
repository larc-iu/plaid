import { countOf } from '@ui/lib/plural.js';

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
const failureParts = (result, verb) => {
  const failed = Array.isArray(result?.sentencesFailed) ? result.sentencesFailed.length : 0;
  const notAsked = Array.isArray(result?.sentencesNotAsked) ? result.sentencesNotAsked.length : 0;
  return [
    ...(failed ? [`could not ${verb} ${countOf(failed, 'sentence')}`] : []),
    ...(notAsked
      ? [`stopped early: the model did not answer (${countOf(notAsked, 'sentence')} not asked)`]
      : []),
  ];
};

// A field a service reads only for context, and went on without.
const missingPart = (name, scope, what) =>
  name ? [`read no ${what} (no ${scope} field “${name}”)`] : [];

export const translateParts = (result) => {
  const written = count(result?.sentencesWritten);
  return {
    wrote: written > 0,
    parts: [
      ...(written ? [`proposed translations for ${countOf(written, 'sentence')}`] : []),
      ...failureParts(result, 'translate'),
      ...missingPart(result?.glossFieldMissing, 'morpheme', 'glosses'),
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
      ...(written ? [`proposed analyses for ${countOf(written, 'word')}`] : []),
      ...(kept
        ? [
            `left ${countOf(kept, 'word')} with a person’s morphemes or morpheme glosses alone (“Overwrite human-edited annotations” replaces them)`,
          ]
        : []),
      ...(unaligned ? [`got no analysis for ${countOf(unaligned, 'word')}`] : []),
      ...failureParts(result, 'analyze'),
      ...missingPart(result?.translationFieldMissing, 'sentence', 'translations'),
    ],
  };
};

// The one toast for the parts of every step that ran. The violet line is a
// promise about material on screen, so it is only made when something was
// written.
export const partsNotice = ({ parts, wrote }) => {
  const msg = parts.length
    ? `${parts.join(', ')}.${wrote ? ' Shown in violet until confirmed.' : ''}`
    : 'Nothing new to apply.';
  return {
    level: wrote ? 'success' : 'warning',
    title: 'Auto-analyze',
    message: msg.charAt(0).toUpperCase() + msg.slice(1),
  };
};

export const translateNotice = (result) => partsNotice(translateParts(result));
export const analyzeNotice = (result) => partsNotice(analyzeParts(result));
