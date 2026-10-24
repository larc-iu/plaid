// What to say about a finished comparison, from the counts the service
// reports (the core manual, "Service results"): `scores`, `against`,
// `sentencesScored` and `sentencesSkipped`, the sentences the metric could
// not read. The words are this app's: a service sends counts only (R18).
// The same rule as draftNotice: never claim more than we know.
//
// Pure, so `test/adjudication.test.js` can drive every shape.
import { countOf } from '../../../plaid-ui/src/lib/plural.js';
import { percent } from './adjudication.js';

// A score as the Compare tab prints it, or null when there is none.
const pct = (x) => (typeof x === 'number' ? percent(x) : null);
const count = (n) => (Number.isInteger(n) && n > 0 ? n : 0);

export const compareNotice = (summary) => {
  const scores = summary?.scores || {};
  const against = summary?.against?.name;
  const scored = count(summary?.sentencesScored);
  const skipped = count(summary?.sentencesSkipped);
  const unread = skipped ? ` Could not read ${countOf(skipped, 'sentence')}.` : '';
  const parts = [];
  const sentence = pct(scores.sentence);
  const comprehensive = pct(scores.comprehensive);
  if (sentence) parts.push(`Sentence graphs ${sentence}`);
  if (comprehensive) parts.push(`comprehensive ${comprehensive}`);
  if (!parts.length || (!scored && skipped)) {
    return {
      level: 'warning',
      title: 'Nothing scored',
      message: skipped
        ? `Could not read a graph in any of the ${countOf(skipped, 'sentence')}.`
        : 'No scores.',
    };
  }
  return {
    level: 'success',
    title: against ? `Compared with ${against}` : 'Compared',
    message: `${parts.join(', ')}.${scored ? ` Scored ${countOf(scored, 'sentence')}.` : ''}${unread}`,
  };
};
