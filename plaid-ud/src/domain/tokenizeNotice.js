// What a finished Tokenize says when the tokenizer found nothing to do: the
// reason code a service reports with zero counts (R23). Any other result gets
// the fixed copy (null).
//
// Pure, so it is tested on its own. By its real path: the `node --test` suite
// has no `@ui` alias.
import { msg, t } from '../../../plaid-ui/src/lib/i18n.js';

const NOTHING = {
  'no-text': msg('The document has no text.'),
  'no-words': msg('No words found in the text.'),
};

export const tokenizeNotice = (result) =>
  NOTHING[result?.reason]
    ? { level: 'warning', title: t('Nothing to tokenize'), message: t(NOTHING[result.reason]) }
    : null;
