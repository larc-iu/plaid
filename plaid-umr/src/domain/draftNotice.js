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
import { listOf, msg, t } from '../../../plaid-ui/src/lib/i18n.js';

const count = (n) => (Number.isInteger(n) && n > 0 ? n : 0);

// `Sentence 3`, `Sentences 3 and 5`, `Sentences 2, 4 and 7`.
const sentences = (numbers) =>
  numbers.length === 1
    ? t('Sentence {n}', { n: numbers[0] })
    : t('Sentences {list}', { list: listOf(numbers) });

// The causes a service reports as a code (R23), in this app's words.
// Messages: shown through t().
const CODES = {
  'no-link-or-gloss': msg('No word has a vocabulary link or a gloss.'),
  'no-link-no-gloss-line': msg(
    'No word has a vocabulary link, and UMR settings name no word or morpheme gloss line.',
  ),
};

// A reason the service wrote is shown as it came, ended with a full stop.
const reasonOf = (failure) => {
  if (CODES[failure?.code]) return t(CODES[failure.code]);
  const text = String(failure?.reason ?? '').trim() || t('No reason given.');
  return /[.!?]$/.test(text) ? text : `${text}.`;
};

// Every failed sentence with its own reason, sentences that failed for the
// same reason named together, in the order reported:
//   Failed to draft sentence 3: The reply was cut off at the token limit.
//   Failed to draft 3 sentences. Sentence 2: ... Sentences 4 and 7: ...
const failureLine = (failures) => {
  if (failures.length === 1) {
    const [only] = failures;
    return t('Failed to draft sentence {n}: {reason}', {
      n: only.sentence,
      reason: reasonOf(only),
    });
  }
  const byReason = new Map();
  for (const f of failures) {
    const reason = reasonOf(f);
    byReason.set(reason, [...(byReason.get(reason) ?? []), f.sentence]);
  }
  const groups = [...byReason].map(([reason, numbers]) =>
    t('{label}: {error}', { label: sentences(numbers), error: reason }),
  );
  return [t('Failed to draft {n} sentences.', { n: failures.length }), ...groups].join(' ');
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
        t(
          '{n, plural, one {{n} sentence was drafted as the graph it already has.} other {{n} sentences were drafted as the graphs they already have.}}',
          { n: unchanged },
        ),
      ]
    : [];
  const held = [
    ...(kept
      ? [
          t('Kept {n, plural, one {# sentence} other {# sentences}} a person had worked on.', {
            n: kept,
          }),
        ]
      : []),
    ...(linked
      ? [
          t(
            'Kept {n, plural, one {# sentence} other {# sentences}} that another sentence links to.',
            { n: linked },
          ),
        ]
      : []),
  ];
  const failed = [
    ...(failures.length ? [failureLine(failures)] : []),
    ...(notAsked.length
      ? [
          t(
            'Stopped early: the model did not answer. {n, plural, one {# sentence was} other {# sentences were}} not drafted.',
            { n: notAsked.length },
          ),
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
      ? [
          t('Skipped {n, plural, one {# sentence} other {# sentences}} that already had a graph.', {
            n: skipped,
          }),
        ]
      : [];
    // A run some sentences of which failed is not a success to tick off.
    return notice(
      failed.length ? 'warning' : 'success',
      t('Drafted {n, plural, one {# sentence} other {# sentences}}', { n: drafted }),
      [...same, ...skippedLine, ...held, ...failed],
    );
  }
  if (unchanged && !skipped) {
    return notice(failed.length ? 'warning' : 'success', t('Document not modified'), [
      ...same,
      ...held,
      ...failed,
    ]);
  }
  if (skipped) {
    // “Overwrite existing graphs” is the drafting service's own name for its
    // option, shown as the service sends it.
    const overwrite =
      skipped > 1 && !held.length && !failed.length
        ? t(
            'All {n} sentences already have graphs. Turn on “Overwrite existing graphs” to draft over them.',
            { n: skipped },
          )
        : t(
            '{n, plural, one {{n} sentence already has a graph. Turn on “Overwrite existing graphs” to draft over it.} other {{n} sentences already have graphs. Turn on “Overwrite existing graphs” to draft over them.}}',
            { n: skipped },
          );
    return notice('warning', t('Document not modified'), [overwrite, ...same, ...held, ...failed]);
  }
  if (held.length) return notice('warning', t('Document not modified'), [...held, ...failed]);
  if (failed.length) return notice('warning', t('Nothing drafted'), failed);
  return notice('warning', t('Nothing to draft'), [t('The document has no sentences in scope.')]);
};
