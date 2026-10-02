import { Notice } from './Notice.jsx';
import { LONG_DOCUMENT_WORDS, isLongDocument } from '../../domain/longDocument.js';

/**
 * The notice an editor shows over a document long enough to be slow to edit,
 * or nothing. `words` is the document's word count.
 */
export const LongDocumentNotice = ({ words, className }) =>
  isLongDocument(words) ? (
    <Notice tone="warning" className={className} data-testid="long-document">
      <p className="font-medium">Long document</p>
      <p className="text-xs">
        {words.toLocaleString()} words. Editing slows down past{' '}
        {LONG_DOCUMENT_WORDS.toLocaleString()} words. Split it into shorter documents.
      </p>
    </Notice>
  ) : null;
