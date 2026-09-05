import { useCallback } from 'react';
import { cpSlice, cpLength } from '@larc-iu/plaid-client';
import { useDocumentCtx } from '../contexts/DocumentContext.jsx';
import { useIgtDocument } from '../../../domain/useIgtDocument.js';
import { alignableRange } from '../../../domain/mutations/alignment.js';

// The timeline popover's operations, backed by the shared IgtDocument: make a
// segment from new text, or over a stretch of the baseline text still free
// between the neighbouring segments. The two mutations delegate straight to
// the domain methods (which patch in place, reload on error, and toast).
// `isProcessing` mirrors `doc.isSaving`. Editing and deleting an existing
// segment happen in its transcript row, not here.
export const useAlignmentEditor = (selection, onAlignmentCreated) => {
  const { doc } = useDocumentCtx();
  useIgtDocument(doc);

  // The stretch of baseline text a segment at `selection` may take: whatever
  // lies between the segment before it in time and the one after. Code points.
  const getAvailableTextBoundaries = useCallback(
    () =>
      alignableRange(
        doc.alignmentTokens || [],
        cpLength(doc.body || ''),
        selection.start,
        selection.end,
      ),
    [doc, selection],
  );

  const getAvailableText = useCallback(() => {
    const { leftBoundary, rightBoundary } = getAvailableTextBoundaries();
    return cpSlice(doc.body || '', leftBoundary, rightBoundary);
  }, [getAvailableTextBoundaries, doc]);

  const canAlign = useCallback(() => getAvailableText().trim().length > 0, [getAvailableText]);

  const createAlignment = useCallback(
    async (text, speaker) => {
      const ok = await doc.createAlignment({
        text,
        timeBegin: selection.start,
        timeEnd: selection.end,
        speaker,
      });
      if (ok && onAlignmentCreated) onAlignmentCreated();
      return ok;
    },
    [doc, selection, onAlignmentCreated],
  );

  // `begin` and `end` are code-point offsets into the body.
  const alignBaseline = useCallback(
    async (begin, end, speaker) => {
      const ok = await doc.alignBaseline({
        begin,
        end,
        timeBegin: selection.start,
        timeEnd: selection.end,
        speaker,
      });
      if (ok && onAlignmentCreated) onAlignmentCreated();
      return ok;
    },
    [doc, selection, onAlignmentCreated],
  );

  return {
    isProcessing: doc.isSaving,
    createAlignment,
    alignBaseline,
    getAvailableTextBoundaries,
    getAvailableText,
    canAlign,
  };
};
