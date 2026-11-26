// What to say about a finished comparison, from the counts the service
// reports (the core manual, "Service results"): `scores`, `against`,
// `sentencesScored` and `sentencesSkipped`, the sentences the metric could
// not read. The words are this app's: a service sends counts only (R18).
// The same rule as draftNotice: never claim more than we know.
//
// Pure, so `test/adjudication.test.js` can drive every shape.
import { t } from '../../../plaid-ui/src/lib/i18n.js';
import { percent } from './adjudication.js';

// A score as the Compare tab prints it, or null when there is none.
const pct = (x) => (typeof x === 'number' ? percent(x) : null);
const count = (n) => (Number.isInteger(n) && n > 0 ? n : 0);

// The scores line, as one message for each pair of scores there is.
const scoresLine = (sentence, comprehensive) =>
  sentence && comprehensive
    ? t('Sentence graphs {sentence}, comprehensive {comprehensive}.', { sentence, comprehensive })
    : sentence
      ? t('Sentence graphs {sentence}.', { sentence })
      : t('comprehensive {comprehensive}.', { comprehensive });

export const compareNotice = (summary) => {
  const scores = summary?.scores || {};
  const against = summary?.against?.name;
  const scored = count(summary?.sentencesScored);
  const skipped = count(summary?.sentencesSkipped);
  const sentence = pct(scores.sentence);
  const comprehensive = pct(scores.comprehensive);
  if ((!sentence && !comprehensive) || (!scored && skipped)) {
    return {
      level: 'warning',
      title: t('Nothing scored'),
      message: skipped
        ? t(
            'Could not read a graph in any of the {n, plural, one {# sentence} other {# sentences}}.',
            { n: skipped },
          )
        : t('No scores.'),
    };
  }
  return {
    level: 'success',
    title: against ? t('Compared with {name}', { name: against }) : t('Compared'),
    message: [
      scoresLine(sentence, comprehensive),
      scored && t('Scored {n, plural, one {# sentence} other {# sentences}}.', { n: scored }),
      skipped &&
        t('Could not read {n, plural, one {# sentence} other {# sentences}}.', { n: skipped }),
    ]
      .filter(Boolean)
      .join(' '),
  };
};
