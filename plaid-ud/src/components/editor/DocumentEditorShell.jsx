import { useState, useEffect, useCallback, useMemo } from 'react';
import { useParams, useLocation, Outlet } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { ConlluDocument } from '../../domain/ConlluDocument.js';
import { useConlluDocument } from '../../domain/useConlluDocument.js';
import { DocumentTabs } from './DocumentTabs.jsx';
import { CommentStore } from '@ui/domain/CommentStore';
import { useCommentStore } from '@ui/domain/useCommentStore';
import { canEditProject, canManageProject } from '../../utils/permissions.js';

// Parent route of the four document tabs (/edit, /annotate, /export, /details).
// It owns the project + ConlluDocument load and renders the breadcrumbs and the
// tab strip, so a tab switch swaps ONLY the body: the shell's route params don't
// change, so React Router keeps it mounted.
//
// Each tab used to be a sibling route that rendered its own copy of
// `DocumentTabs` *behind its own loading gate*, so every switch unmounted the
// chrome, flashed a bare spinner where the whole page had been, and
// re-downloaded the entire document. Keep the chrome here, above the loading
// gate, and keep the tabs children of this route — that is the whole point of
// the shell.

// The annotation editor is full-bleed and supplies its own padding; the others
// sit in `Layout`'s centered container, which already pads them.
const isWideRoute = (pathname) => pathname.includes('/annotate');

export const DocumentEditorShell = () => {
  const { projectId, documentId } = useParams();
  const { pathname } = useLocation();
  const { getClient, logout, user } = useAuth();

  const [doc, setDoc] = useState(null);
  const [project, setProject] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  // The annotation editor's history drawer pushes its content right rather than
  // overlaying it. The chrome lives up here now, so it has to move too — the
  // child publishes the offset through the outlet context.
  const [chromeOffset, setChromeOffset] = useState(0);

  // One comment store per document, shared by every tab through the outlet, so
  // the Comments tab and the grid's badges read the same instance rather than
  // each loading the thread list.
  //
  // Comments are SOCIAL data, not annotation data: the store is separate from
  // ConlluDocument on purpose, never bumps the document version, and is
  // deliberately absent from the document read.
  const comments = useMemo(
    () =>
      documentId && user?.id
        ? new CommentStore({ client: getClient(), projectId, documentId, currentUserId: user.id })
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [projectId, documentId, user?.id],
  );
  useCommentStore(comments);
  useEffect(() => {
    comments?.load();
  }, [comments]);
  // The tab strip is chrome, so it survives a tab switch — but it must not be
  // clickable while the body is repairing the document (see DocumentTabs). The
  // child raises this the same way it publishes its offset.
  const [chromeBusy, setChromeBusy] = useState(false);

  // Re-render on any mutation of the shared document (see useConlluDocument).
  useConlluDocument(doc);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      const client = getClient();
      if (!client) {
        logout();
        return;
      }
      try {
        setLoading(true);
        const [projectData, raw] = await Promise.all([
          client.projects.get(projectId),
          client.documents.get(documentId, true),
        ]);
        if (cancelled) return;
        // The project and the user ride along so the document writes as this
        // person (provenance convention: see ConlluDocument.writer).
        const next = new ConlluDocument({
          raw,
          client,
          projectId,
          project: projectData,
          user,
        });
        setProject(projectData);
        setDoc(next);
        setLoadError('');
      } catch (err) {
        if (cancelled) return;
        if (err.status === 401) {
          logout();
          return;
        }
        setLoadError('Failed to load document: ' + (err.message || 'Unknown error'));
        console.error('Error fetching data:', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    run();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, documentId]);

  // Resync after something outside this app changed the document (an NLP
  // service parse, mainly). The ConlluDocument is refreshed in place so the
  // annotation grid isn't remounted.
  const reload = useCallback(async () => {
    const client = getClient();
    if (!client) return;
    try {
      const [projectData] = await Promise.all([
        client.projects.get(projectId),
        doc ? doc.reload() : Promise.resolve(),
      ]);
      setProject(projectData);
    } catch (err) {
      if (err.status === 401) {
        logout();
        return;
      }
      console.error('Error refreshing document:', err);
    }
  }, [projectId, doc, getClient, logout]);

  // A save in flight lives only in this tab, so a reload or a tab close drops
  // it silently. Warn while `_withSaving` holds the gate (the browser shows its
  // own prompt). The handler reads the getter at fire time, so it never sees a
  // stale flag.
  useEffect(() => {
    if (!doc) return;
    const onBeforeUnload = (e) => {
      if (!doc.isSaving) return;
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [doc]);

  const wide = isWideRoute(pathname);

  return (
    <div className="w-full">
      {/* Chrome: rendered unconditionally, including while the document loads.
          That is what stops the tab switch from blanking the page. */}
      <div
        style={{ marginLeft: chromeOffset, transition: 'margin-left 300ms ease' }}
        className={wide ? 'px-6 pt-4' : undefined}
      >
        <DocumentTabs
          projectId={projectId}
          documentId={documentId}
          project={project}
          document={doc?.raw}
          disabled={chromeBusy}
        />
      </div>

      {loading && <p className="p-4 text-sm text-muted-foreground">Loading…</p>}

      {!loading && (loadError || !doc || !project) && (
        <div className={wide ? 'px-6' : undefined}>
          <div
            role="alert"
            className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {loadError || 'Document or project not found'}
          </div>
        </div>
      )}

      {!loading && !loadError && doc && project && (
        <Outlet
          context={{
            projectId,
            documentId,
            doc,
            project,
            reload,
            comments,
            canComment: canEditProject(project, user),
            canDeleteAnyComment: canManageProject(project, user),
            setChromeOffset,
            setChromeBusy,
          }}
        />
      )}
    </div>
  );
};
