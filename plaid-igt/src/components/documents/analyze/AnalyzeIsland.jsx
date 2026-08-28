import { useEffect, useRef, useState } from 'react';
import { IgtEditor } from './island/IgtEditor.js';
import { AutoAnalyzeDialog } from './AutoAnalyzeDialog.jsx';
import { useDocumentCtx } from '../contexts/DocumentContext.jsx';
import { useAuth } from '../../../contexts/AuthContext.jsx';

// Thin React shell around the vanilla IgtEditor island. Consumes the single
// shared IgtDocument from DocumentContext (the same instance the other tabs use)
// instead of loading its own — this is what kills the old double-fetch. The
// island owns all rendering + edits; React just manages the mount lifecycle.
//
// Time-travel: DocumentDetail reloads the shared doc when `asOf` changes, so the
// doc identity changes and the mount effect below re-mounts the island onto the
// new historical snapshot automatically. readOnly is synced without remounting.
export const AnalyzeIsland = () => {
  const { doc, readOnly } = useDocumentCtx();
  const hostRef = useRef(null);
  const editorRef = useRef(null);
  // The island's Auto-analyze toolbar button requests this React-side modal
  // (service discovery + param forms are React machinery) via a window event.
  const [autoAnalyzeOpen, setAutoAnalyzeOpen] = useState(false);

  useEffect(() => {
    const onOpen = () => setAutoAnalyzeOpen(true);
    window.addEventListener('igt:auto-analyze-open', onOpen);
    return () => window.removeEventListener('igt:auto-analyze-open', onOpen);
  }, []);

  // Vocab-entry creation needs vocab-maintainer rights (linking needs less);
  // the island hides its "+ Create" row for vocabs this user can't add to.
  const { user } = useAuth();
  const canWriteVocab = (vocab) =>
    !!user && (user.isAdmin === true || (vocab?.maintainers || []).includes(user.id));

  useEffect(() => {
    if (!doc || !hostRef.current) return undefined;
    editorRef.current = new IgtEditor(hostRef.current, doc, { readOnly, canWriteVocab });
    return () => {
      if (editorRef.current) {
        editorRef.current.destroy();
        editorRef.current = null;
      }
    };
    // readOnly intentionally excluded — synced via the effect below without
    // tearing down the island. doc identity changes on (re)load / time-travel.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc]);

  useEffect(() => {
    if (editorRef.current) editorRef.current.setReadOnly(readOnly);
  }, [readOnly]);

  return (
    <div className="igt-analyze-mount" style={{ paddingTop: 16 }}>
      {!doc && <div style={{ padding: 24, color: '#6b7280' }}>Loading interlinear editor…</div>}
      <div ref={hostRef} className="igt-island" style={{ display: doc ? 'block' : 'none' }} />
      {doc && (
        <AutoAnalyzeDialog open={autoAnalyzeOpen} onOpenChange={setAutoAnalyzeOpen} doc={doc} />
      )}
    </div>
  );
};
