// What to say about a finished parse, from the counts the service reports
// (the core manual, "Service results"): `parsedSentences`,
// `unchangedSentences`, those of them that parsed as they are stored, and
// `skippedSentences`, the sentences kept because a person made or verified
// annotations in them. `reason: 'no-text'` is a document with no text.
//
// The rule (C8): never claim more than we know. A service reports a
// per-sentence skip in its counts, not by failing the request, so a run where
// every sentence was skipped still comes back `status: success` with zeros.
// Announcing "Parsed!" over an untouched document is the bug this exists to
// prevent. The words are this app's: a service sends counts only (R18).
//
// Pure, so `test/parseNotice.test.js` can drive every shape.
import { t } from '../../../plaid-ui/src/lib/i18n.js';

const count = (n) => (Number.isInteger(n) && n > 0 ? n : 0);

// What a run says of the sentences it kept for a person.
const keptMessage = (skipped) =>
  t('Kept {n, plural, one {# sentence} other {# sentences}} with a person’s annotations.', {
    n: skipped,
  });

export const parseNotice = (summary) => {
  if (summary?.reason === 'no-text') {
    return {
      level: 'warning',
      title: t('Nothing to parse'),
      message: t('The document has no text.'),
    };
  }
  const parsed = count(summary?.parsedSentences);
  const skipped = count(summary?.skippedSentences);
  // Every sentence the run parsed came out as it is stored, so it wrote
  // nothing (`unchangedSentences`, counted among the parsed).
  if (parsed > 0 && count(summary?.unchangedSentences) >= parsed) {
    const asStored = t(
      '{n, plural, one {# sentence parses as it is stored.} other {All # sentences parse as they are stored.}}',
      { n: parsed },
    );
    return {
      level: 'warning',
      title: t('Document not modified'),
      // Two whole sentences, side by side.
      message: skipped ? `${asStored} ${keptMessage(skipped)}` : asStored,
    };
  }
  if (parsed > 0) {
    return {
      level: 'success',
      title: t('Parsed {n, plural, one {# sentence} other {# sentences}}', { n: parsed }),
      message: skipped ? keptMessage(skipped) : undefined,
    };
  }
  if (skipped > 0) {
    return {
      level: 'warning',
      title: t('Document not modified'),
      message: t(
        '{n, plural, one {# sentence has annotations a person made or verified. Turn on “Overwrite” to parse them.} other {All # sentences have annotations a person made or verified. Turn on “Overwrite” to parse them.}}',
        { n: skipped },
      ),
    };
  }
  return {
    level: 'warning',
    title: t('Nothing to parse'),
    message: t('The document has no sentences to parse.'),
  };
};
