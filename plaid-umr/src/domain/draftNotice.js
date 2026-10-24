// What to say about a finished draft run, from the counts the service
// reports (the core manual, "Service results"). The words are this app's: a
// service sends counts only (R18).
//
// The rule: never claim more than we know. A drafting service reports a
// per-sentence failure in its counts rather than by failing the request, so a
// run where every sentence was skipped or refused still comes back
// `status: success` with zeros. Announcing "Drafted" over an untouched
// document is the bug this exists to prevent.
//
// The counts: `drafted`, the sentences written; `unchanged`, the ones whose
// new draft is the graph they already have, so nothing was written; `skipped`, the sentences with a machine-made graph
// left alone with Overwrite off (the only ones the Overwrite hint is true
// of); `kept`, the ones a person made, contributed to or accepted something
// in; `linked`, the ones another sentence's graph links into;
// `sentencesFailed`, `{sentence, reason}` or `{sentence, code}` per sentence
// the run could not draft (a code is a cause this app words, CODES); and `sentencesNotDrafted`, the sentences never asked about because
// the model stopped answering. A notice that names failed sentences is
// `sticky`: it stays until dismissed, since it is the only record of them.
//
// Pure, so `test/draftNotice.test.js` can drive every shape.
import { countOf } from '../../../plaid-ui/src/lib/plural.js';

const count = (n) => (Number.isInteger(n) && n > 0 ? n : 0);

// `Sentence 3`, `Sentences 3 and 5`, `Sentences 2, 4 and 7`.
const sentences = (numbers) =>
  numbers.length === 1
    ? `Sentence ${numbers[0]}`
    : `Sentences ${numbers.slice(0, -1).join(', ')} and ${numbers[numbers.length - 1]}`;

// The causes a service reports as a code (R23), in this app's words.
const CODES = {
  'no-link-or-gloss': 'No word has a vocabulary link or a gloss.',
  'no-link-no-gloss-line':
    'No word has a vocabulary link, and UMR settings name no word or morpheme gloss line.',
};

const reasonOf = (failure) => {
  if (CODES[failure?.code]) return CODES[failure.code];
  const text = String(failure?.reason ?? '').trim() || 'No reason given.';
  return /[.!?]$/.test(text) ? text : `${text}.`;
};

// Every failed sentence with its own reason, sentences that failed for the
// same reason named together, in the order reported:
//   Failed to draft sentence 3: The reply was cut off at the token limit.
//   Failed to draft 3 sentences. Sentence 2: ... Sentences 4 and 7: ...
const failureLine = (failures) => {
  if (failures.length === 1) {
    const [only] = failures;
    return `Failed to draft sentence ${only.sentence}: ${reasonOf(only)}`;
  }
  const byReason = new Map();
  for (const f of failures) {
    const reason = reasonOf(f);
    byReason.set(reason, [...(byReason.get(reason) ?? []), f.sentence]);
  }
  const groups = [...byReason].map(([reason, numbers]) => `${sentences(numbers)}: ${reason}`);
  return `Failed to draft ${failures.length} sentences. ${groups.join(' ')}`;
};

export const draftNotice = (summary) => {
  const drafted = count(summary?.drafted);
  const unchanged = count(summary?.unchanged);
  const skipped = count(summary?.skipped);
  const kept = count(summary?.kept);
  const linked = count(summary?.linked);
  const failures = Array.isArray(summary?.sentencesFailed) ? summary.sentencesFailed : [];
  const notAsked = Array.isArray(summary?.sentencesNotDrafted) ? summary.sentencesNotDrafted : [];

  const same = unchanged
    ? [
        unchanged === 1
          ? '1 sentence was drafted as the graph it already has.'
          : `${unchanged} sentences were drafted as the graphs they already have.`,
      ]
    : [];
  const held = [
    ...(kept ? [`Kept ${countOf(kept, 'sentence')} a person had worked on.`] : []),
    ...(linked ? [`Kept ${countOf(linked, 'sentence')} that another sentence links to.`] : []),
  ];
  const failed = [
    ...(failures.length ? [failureLine(failures)] : []),
    ...(notAsked.length
      ? [
          `Stopped early: the model did not answer. ${countOf(notAsked.length, 'sentence')} ${
            notAsked.length === 1 ? 'was' : 'were'
          } not drafted.`,
        ]
      : []),
  ];
  const notice = (level, title, parts) => ({
    level,
    title,
    message: parts.join(' '),
    ...(failed.length ? { sticky: true } : {}),
  });

  if (drafted) {
    const skippedLine = skipped
      ? [`Skipped ${countOf(skipped, 'sentence')} that already had a graph.`]
      : [];
    // A run some sentences of which failed is not a success to tick off.
    return notice(
      failed.length ? 'warning' : 'success',
      `Drafted ${countOf(drafted, 'sentence')}`,
      [...same, ...skippedLine, ...held, ...failed],
    );
  }
  if (unchanged && !skipped) {
    return notice(failed.length ? 'warning' : 'success', 'Document not modified', [
      ...same,
      ...held,
      ...failed,
    ]);
  }
  if (skipped) {
    const [subject, them] =
      skipped === 1
        ? ['1 sentence already has a graph', 'it']
        : held.length || failed.length
          ? [`${skipped} sentences already have graphs`, 'them']
          : [`All ${skipped} sentences already have graphs`, 'them'];
    return notice('warning', 'Document not modified', [
      `${subject}. Turn on “Overwrite existing graphs” to draft over ${them}.`,
      ...same,
      ...held,
      ...failed,
    ]);
  }
  if (held.length) return notice('warning', 'Document not modified', [...held, ...failed]);
  if (failed.length) return notice('warning', 'Nothing drafted', failed);
  return notice('warning', 'Nothing to draft', ['The document has no sentences in scope.']);
};
