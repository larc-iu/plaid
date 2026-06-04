import { useCallback } from 'react';
import { useDocumentCtx } from '../contexts/DocumentContext.jsx';
import { useIgtDocument } from '../../../domain/useIgtDocument.js';

// Alignment popover operations, backed by the shared IgtDocument. The read
// helpers (existing alignment lookup, available-text boundaries, canAlign) are
// derived from `doc.alignmentTokens` + `doc.body`; the four mutations delegate
// straight to the domain methods (which do the batch/cascade + optimistic patch
// + reload-on-error + error toast). `isProcessing` mirrors `doc.isSaving`.
export const useAlignmentEditor = (selection, onAlignmentCreated) => {
  const { doc } = useDocumentCtx();
  useIgtDocument(doc);

  // Find existing alignment token that matches current selection
  const getExistingAlignment = useCallback(() => {
    return (doc.alignmentTokens || []).find(token =>
      token.metadata?.timeBegin === selection?.start &&
      token.metadata?.timeEnd === selection?.end
    );
  }, [selection, doc]);

  // Find available text boundaries for alignment
  const getAvailableTextBoundaries = useCallback(() => {
    const alignmentTokens = doc.alignmentTokens || [];
    const sortedTokens = [...alignmentTokens].sort((a, b) =>
      (a.metadata?.timeBegin || 0) - (b.metadata?.timeBegin || 0)
    );

    const textLength = doc.body?.length || 0;

    // Find constraints from neighboring alignment tokens
    let leftBoundary = 0;
    let rightBoundary = textLength;

    for (const token of sortedTokens) {
      const tokenTimeBegin = token.metadata?.timeBegin || 0;
      const tokenTimeEnd = token.metadata?.timeEnd || 0;

      if (tokenTimeEnd <= selection.start && token.end > leftBoundary) {
        leftBoundary = token.end;
      }
      if (tokenTimeBegin >= selection.end && token.begin < rightBoundary) {
        rightBoundary = token.begin;
      }
    }

    return { leftBoundary, rightBoundary };
  }, [doc, selection]);

  // Get available text for alignment
  const getAvailableText = useCallback(() => {
    const { leftBoundary, rightBoundary } = getAvailableTextBoundaries();
    const fullText = doc.body || '';
    return fullText.substring(leftBoundary, rightBoundary);
  }, [getAvailableTextBoundaries, doc]);

  // Check if baseline text is available for alignment
  const canAlign = useCallback(() => {
    const availableText = getAvailableText();
    return availableText.trim().length > 0;
  }, [getAvailableText]);

  // Create new alignment
  const createAlignment = useCallback(async (text) => {
    const ok = await doc.createAlignment({ text, timeBegin: selection.start, timeEnd: selection.end });
    if (ok && onAlignmentCreated) {
      onAlignmentCreated();
    }
    return ok;
  }, [doc, selection, onAlignmentCreated]);

  // Edit existing alignment
  const editAlignment = useCallback(async (text, existingAlignment) => {
    if (!existingAlignment) return false;
    const ok = await doc.editAlignment(existingAlignment.id, { text, timeBegin: selection.start, timeEnd: selection.end });
    if (ok && onAlignmentCreated) {
      onAlignmentCreated();
    }
    return ok;
  }, [doc, selection, onAlignmentCreated]);

  // Align existing baseline text
  const alignBaseline = useCallback(async (text) => {
    const ok = await doc.alignBaseline({ text, timeBegin: selection.start, timeEnd: selection.end });
    if (ok && onAlignmentCreated) {
      onAlignmentCreated();
    }
    return ok;
  }, [doc, selection, onAlignmentCreated]);

  // Delete alignment
  const deleteAlignment = useCallback(async (existingAlignment) => {
    if (!existingAlignment) return false;
    const ok = await doc.deleteAlignment(existingAlignment.id);
    if (ok && onAlignmentCreated) {
      onAlignmentCreated();
    }
    return ok;
  }, [doc, onAlignmentCreated]);

  return {
    // State
    isProcessing: doc.isSaving,

    // Operations
    createAlignment,
    editAlignment,
    alignBaseline,
    deleteAlignment,

    // Calculations
    getAvailableTextBoundaries,
    getAvailableText,
    getExistingAlignment,
    canAlign
  };
};
