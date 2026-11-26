import { Notice } from './Notice.jsx';
import { LONG_DOCUMENT_WORDS, isLongDocument } from '../../domain/longDocument.js';
import { t } from '../../lib/i18n.js';

/**
 * The notice an editor shows over a document long enough to be slow to edit,
 * or nothing. `words` is the document's word count. Plain information: a long
 * document is not a fault, and the warm tones are for what is broken.
 */
export const LongDocumentNotice = ({ words, className }) =>
  isLongDocument(words) ? (
    <Notice tone="info" className={className} data-testid="long-document">
      <p className="font-medium">{t('Long document')}</p>
      <p className="text-xs">
        {t(
          '{n, plural, one {# word} other {# words}}. Editing slows down past {max, number} words. Split it into shorter documents.',
          { n: words, max: LONG_DOCUMENT_WORDS },
        )}
      </p>
    </Notice>
  ) : null;
