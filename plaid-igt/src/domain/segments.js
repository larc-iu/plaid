// Segments (time-alignment tokens) as the Media and Tokenize tabs reason
// about them, without React or the document: which ones carry a given text,
// and where sentence breaks would go to make one sentence per segment.

import { cpSlice } from '@larc-iu/plaid-client';
import { lossPhrase } from '@ui/domain/annotationLoss.js';
import { t, msg } from '@ui/lib/i18n.js';

/** A segment's own stretch of the baseline, trimmed. */
export const segmentText = (body, token) => cpSlice(body ?? '', token.begin, token.end).trim();

/**
 * The segments whose text is `value` (trimmed on both sides), which for an
 * empty `value` is every segment with no text at all: the placeholders a
 * person makes and never types into.
 */
export const segmentsWithText = (tokens, body, value) => {
  const want = String(value ?? '').trim();
  return (tokens || []).filter((tok) => segmentText(body, tok) === want);
};

/**
 * Where the sentence layer would be split so that each segment starts a
 * sentence. A segment's start qualifies when it lies strictly inside a
 * sentence (a sentence already beginning there needs nothing) and not inside
 * a word, since a word belongs to one sentence and the server refuses a cut
 * through it. Splits only: a segment that spans several sentences leaves
 * them as they are.
 *
 * @returns {{positions: number[], insideWord: number}}
 *   positions in ascending order, plus how many starts were skipped for
 *   falling inside a word.
 */
export function splitPointsFromSegments({ sentences, words, alignments }) {
  const starts = new Set((sentences || []).map((s) => s.begin));
  const positions = new Set();
  let insideWord = 0;
  for (const seg of alignments || []) {
    const p = seg.begin;
    if (starts.has(p)) continue;
    const inSentence = (sentences || []).some((s) => s.begin < p && p < s.end);
    if (!inSentence) continue;
    if ((words || []).some((w) => w.begin < p && p < w.end)) {
      insideWord += 1;
      continue;
    }
    positions.add(p);
  }
  return { positions: [...positions].sort((a, b) => a - b), insideWord };
}

// The Split sentences at segments confirmation, for `n` breaks, `insideWord`
// segments left alone and the split's `loss` (`sentenceSplitLoss`).
export const segmentSplitDescription = (n, insideWord, loss) => {
  const lost = lossPhrase(loss);
  const crossing = (loss?.annotations || 0) + (loss?.links || 0);
  return [
    t(
      '{n, plural, one {# sentence break will be added where segments start.} other {# sentence breaks will be added where segments start.}}',
      { n },
    ),
    insideWord
      ? t(
          '{n, plural, one {# segment starts inside a word and is left alone.} other {# segments start inside a word and are left alone.}}',
          { n: insideWord },
        )
      : '',
    lost
      ? t(
          '{crossing, plural, one {{n, plural, one {Deletes {lost} that crosses the new break.} other {Deletes {lost} that crosses the new breaks.}}} other {{n, plural, one {Deletes {lost} that cross the new break.} other {Deletes {lost} that cross the new breaks.}}}}',
          { crossing, n, lost },
        )
      : '',
    mweSplitSentences(loss),
  ]
    .filter(Boolean)
    .join(' ');
};

// What a sentence split does to the MWEs it hides or shows in part, each
// kind `[key, n, plain, marked]`: the sentence, and the same with its count
// in <strong>, for tx().
const MWE_SPLIT = [
  [
    'hidden',
    'hiddenMwes',
    msg(
      '{n, plural, one {# multi-word expression will not be shown until the sentences are merged again.} other {# multi-word expressions will not be shown until the sentences are merged again.}}',
    ),
    msg(
      '{n, plural, one {<strong># multi-word expression</strong> will not be shown until the sentences are merged again.} other {<strong># multi-word expressions</strong> will not be shown until the sentences are merged again.}}',
    ),
  ],
  [
    'partial',
    'partialMwes',
    msg(
      '{n, plural, one {# multi-word expression will be shown only in part until the sentences are merged again.} other {# multi-word expressions will be shown only in part until the sentences are merged again.}}',
    ),
    msg(
      '{n, plural, one {<strong># multi-word expression</strong> will be shown only in part until the sentences are merged again.} other {<strong># multi-word expressions</strong> will be shown only in part until the sentences are merged again.}}',
    ),
  ],
];

/**
 * What a sentence split's confirmation says about the MWEs it hides or shows
 * in part (`sentenceSplitLoss`'s `hiddenMwes` and `partialMwes`): one
 * `{ key, n, message }` per kind that has any, `message` a whole sentence
 * with its count in `<strong>`, for `tx(message, { n, strong })`.
 */
export const mweSplitNotes = (loss = {}) =>
  MWE_SPLIT.filter(([, field]) => loss?.[field] > 0).map(([key, field, , marked]) => ({
    key,
    n: loss[field],
    message: marked,
  }));

/**
 * The old form of `mweSplitNotes`: one `[count, rest]` pair per kind that
 * has any, the count to be set apart. Its `rest` is English only: a sentence
 * cut around its count cannot be translated. Use `mweSplitNotes`.
 */
export const mweSplitLines = ({ hiddenMwes = 0, partialMwes = 0 } = {}) =>
  [
    [hiddenMwes, 'will not be shown until the sentences are merged again.'], // i18n-ignore the old fragment API, English only: callers move to mweSplitNotes
    [partialMwes, 'will be shown only in part until the sentences are merged again.'], // i18n-ignore the old fragment API, English only: callers move to mweSplitNotes
  ]
    .filter(([n]) => n > 0)
    .map(([n, rest]) => [
      t('{n, plural, one {# multi-word expression} other {# multi-word expressions}}', { n }),
      rest,
    ]);

/** What `mweSplitNotes` says, as plain sentences one after another, or '' for none. */
export const mweSplitSentences = (loss) =>
  MWE_SPLIT.filter(([, field]) => loss?.[field] > 0)
    .map(([, field, plain]) => t(plain, { n: loss[field] }))
    .join(' ');
