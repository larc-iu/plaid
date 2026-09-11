import { useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { CommentsBrowser } from '@ui/components/shared/CommentsBrowser';
import { useDocumentEditor } from '../editor/useDocumentEditor.js';
import { useConlluDocument } from '../../domain/useConlluDocument.js';
import { buildAnchorIndex } from '../../domain/commentAnchors.js';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';

// The document's Comments tab: every thread in it, the document's own pinned
// first, each one a sentence you can jump to.
//
// Comments are sentence and document level here, by ruling. A thread anchored
// to anything else came from another app sharing this substrate and describes
// as outdated, which is honest: this app cannot show you an IGT gloss.
export const DocumentComments = () => {
  const { projectId, documentId, doc, project, comments, canComment, canDeleteAnyComment } =
    useDocumentEditor();
  const navigate = useNavigate();
  useConlluDocument(doc);

  useDocumentTitle('Comments', doc?.name, project?.name);

  // Live only while this tab is open. The claim is refcounted in the store, so
  // a thread popover in the editor can hold one at the same time and the stream
  // closes when the last of them goes. A plain document load never opens one:
  // an always-open stream is a cost every reader pays for a feature most of
  // them are not using, and it breaks Playwright's `networkidle` besides.
  useEffect(() => comments?.watchLive(), [comments]);

  // Anchor labels come from the document and change only when its DATA does,
  // so they key on the same version the grid's caches do.
  const version = doc?.dataVersion ?? 0;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const anchors = useMemo(() => buildAnchorIndex(doc), [doc, version]);

  return (
    <div className="mx-auto w-full max-w-4xl px-4 pb-8">
      <CommentsBrowser
        store={comments}
        anchors={anchors}
        pinnedId={documentId}
        canWrite={canComment}
        canDeleteAny={canDeleteAnyComment}
        onJumpTo={(sentenceId) =>
          navigate(`/projects/${projectId}/documents/${documentId}/annotate?sent=${sentenceId}`)
        }
        jumpTitle="Show this sentence in the editor"
        emptyText="No comments on this document yet. Add one here, or from a sentence in the editor."
        positionLabel="In text order"
      />
    </div>
  );
};
