import { useCallback } from 'react';
import { cpSlice, cpLength } from '@larc-iu/plaid-client';
import { useDocumentCtx } from '../contexts/DocumentContext.jsx';
import { useDocumentModel } from '@ui/domain/useDocumentModel.js';
import { alignableRange } from '../../../domain/mutations/alignment.js';

// The timeline popover's operations, backed by the shared IgtDocument: make a
// segment from new text, or over a stretch of the baseline text still free
// between the neighbouring segments. The two mutations delegate straight to
// the domain methods (which show the segment at once, reload on error, and
// toast). Editing and deleting an existing segment happen in its transcript
// row, not here.
export const useAlignmentEditor = (selection, onAlignmentCreated) => {
  const { doc } = useDocumentCtx();
  useDocumentModel(doc);

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

  // A segment shows the moment it is made, so the popover is done then: it
  // answers true without waiting for the server, whose refusal reloads the
  // document and says why. One refused before it showed answers false.
  const shownOrRefused = useCallback(
    async (write) => {
      const before = doc.dataVersion;
      const saving = write();
      const ok = doc.dataVersion !== before || (await saving);
      if (ok && onAlignmentCreated) onAlignmentCreated();
      return ok;
    },
    [doc, onAlignmentCreated],
  );

  const createAlignment = useCallback(
    (text, speaker) =>
      shownOrRefused(() =>
        doc.createAlignment({
          text,
          timeBegin: selection.start,
          timeEnd: selection.end,
          speaker,
        }),
      ),
    [doc, selection, shownOrRefused],
  );

  // `begin` and `end` are code-point offsets into the body.
  const alignBaseline = useCallback(
    (begin, end, speaker) =>
      shownOrRefused(() =>
        doc.alignBaseline({
          begin,
          end,
          timeBegin: selection.start,
          timeEnd: selection.end,
          speaker,
        }),
      ),
    [doc, selection, shownOrRefused],
  );

  return {
    createAlignment,
    alignBaseline,
    getAvailableTextBoundaries,
    getAvailableText,
    canAlign,
  };
};
