import { useMemo } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useDocumentCtx } from '../contexts/DocumentContext.jsx';
import { useIgtDocument } from '@/domain/useIgtDocument';
import { buildAnchorIndex } from '@/domain/commentAnchors';
import { CommentsBrowser } from './CommentsBrowser.jsx';

// The document's Comments tab: every thread in the document, described by the
// shared IgtDocument, with the document's own thread pinned first.
export const CommentsTab = () => {
  const { doc, comments, canWrite, canManage } = useDocumentCtx();
  const { projectId, documentId } = useParams();
  const navigate = useNavigate();
  useIgtDocument(doc);

  // Anchor labels are derived from the document and only change when its DATA
  // changes, so they are memoized on dataVersion, the same gate the grid uses.
  const version = doc?.dataVersion ?? 0;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const anchors = useMemo(() => buildAnchorIndex(doc), [doc, version]);

  return (
    <CommentsBrowser
      store={comments}
      anchors={anchors}
      pinnedId={doc?.id ?? null}
      canWrite={canWrite}
      canDeleteAny={canManage}
      // Deep-link into the interlinear editor, focused on the sentence the
      // thread hangs off. `focusSentence` is the param DocumentDetail already
      // reads for exactly this.
      onJumpTo={(sentenceId) =>
        navigate(
          `/projects/${projectId}/documents/${documentId}?tab=analyze&focusSentence=${sentenceId}`,
        )
      }
      jumpTitle="Show in the interlinear editor"
      emptyText="Nothing else in this document has comments yet. Add one from the Analyze tab by hovering a word or a sentence."
      positionLabel="In text order"
    />
  );
};
