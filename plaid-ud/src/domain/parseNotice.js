// What to say about a finished parse, from the counts the service reports
// (the core manual, "Service results"): `parsedSentences`, and
// `skippedSentences`, the sentences kept because a person made or verified
// annotations in them.
//
// The rule (C8): never claim more than we know. A service reports a
// per-sentence skip in its counts, not by failing the request, so a run where
// every sentence was skipped still comes back `status: success` with zeros.
// Announcing "Parsed!" over an untouched document is the bug this exists to
// prevent. The words are this app's: a service sends counts only (R18).
//
// Pure, so `test/parseNotice.test.js` can drive every shape.
import { countOf } from '../../../plaid-ui/src/lib/plural.js';

const count = (n) => (Number.isInteger(n) && n > 0 ? n : 0);

export const parseNotice = (summary) => {
  const parsed = count(summary?.parsedSentences);
  const skipped = count(summary?.skippedSentences);
  if (parsed > 0) {
    return {
      level: 'success',
      title: `Parsed ${countOf(parsed, 'sentence')}`,
      message: skipped
        ? `Kept ${countOf(skipped, 'sentence')} with a person’s annotations.`
        : undefined,
    };
  }
  if (skipped > 0) {
    return {
      level: 'warning',
      title: 'Document not modified',
      message:
        (skipped === 1
          ? '1 sentence has annotations'
          : `All ${countOf(skipped, 'sentence')} have annotations`) +
        ' a person made or verified. Turn on “Overwrite” to parse them.',
    };
  }
  return {
    level: 'warning',
    title: 'Nothing to parse',
    message: 'The document has no sentences to parse.',
  };
};
