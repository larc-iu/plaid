import { useEffect, useRef } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { CommentsIsland } from './island/CommentsIsland.js';
import { useDocumentCtx } from '../contexts/DocumentContext.jsx';

// Thin React shell around the vanilla CommentsIsland — the same shape as
// AnalyzeIsland.jsx. React owns the mount lifecycle and nothing else; the
// island owns all rendering, so the thread view is shared verbatim with the
// Analyze grid's popover instead of existing twice.
export const CommentsTab = () => {
  const { doc, comments, canWrite, canManage } = useDocumentCtx();
  const { projectId, documentId } = useParams();
  const navigate = useNavigate();
  const hostRef = useRef(null);
  const islandRef = useRef(null);

  useEffect(() => {
    if (!comments || !hostRef.current) return undefined;
    islandRef.current = new CommentsIsland(hostRef.current, {
      store: comments,
      doc,
      canWrite,
      canDeleteAny: canManage,
      // Deep-link into the interlinear editor, focused on the sentence the
      // thread hangs off. `focusSentence` is the param DocumentDetail already
      // reads for exactly this.
      onJumpTo: (sentenceId) =>
        navigate(
          `/projects/${projectId}/documents/${documentId}?tab=analyze&focusSentence=${sentenceId}`,
        ),
    });
    return () => {
      islandRef.current?.destroy();
      islandRef.current = null;
    };
    // Permissions are synced below without tearing down the island.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [comments, doc]);

  useEffect(() => {
    islandRef.current?.setPermissions({ canWrite, canDeleteAny: canManage });
  }, [canWrite, canManage]);

  return <div ref={hostRef} className="igt-comments-mount" />;
};
