// What a finished Tokenize says when the tokenizer found nothing to do: the
// reason code a service reports with zero counts (R23). Any other result gets
// the fixed copy (null).
//
// Pure, so it is tested on its own.
import { t, msg } from '@ui/lib/i18n.js';

const NOTHING = {
  'no-text': msg('The document has no text.'),
  'no-words': msg('No words found in the text.'),
};

export const tokenizeNotice = (result) =>
  NOTHING[result?.reason]
    ? { level: 'warning', title: t('Nothing to tokenize'), message: t(NOTHING[result.reason]) }
    : null;
