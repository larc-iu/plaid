import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useParams, useLocation, Outlet, useSearchParams } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { ConlluDocument } from '../../domain/ConlluDocument.js';
import { useConlluDocument } from '../../domain/useConlluDocument.js';
import { DocumentTabs } from './DocumentTabs.jsx';
import { CommentStore } from '@ui/domain/CommentStore';
import { useCommentStore } from '@ui/domain/useCommentStore';
import { useWriteLock } from '@ui/hooks/useWriteLock.js';
import { useViewportFill } from '@ui/hooks/useViewportFill.js';
import { useAssistantAvailable } from '@ui/components/assistant/useAssistantAvailable.js';
import { useResumedRun } from '@ui/hooks/useResumedRun.js';
import { RunBanner } from '@ui/components/services/RunBanner.jsx';
import { useEditorServices } from './hooks/useEditorServices.js';
import { isReviewed } from '@larc-iu/plaid-client';
import { DocumentAssistant } from '@ui/components/assistant/DocumentAssistant.jsx';
import { UD_ASSISTANT } from '../assistant/adapter.js';
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
  const [, setSearchParams] = useSearchParams();

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

  // A service run that writes takes the document read-only for as long as it
  // writes: the run outlives its dialog and ends in a reload, so anything
  // typed underneath it would be discarded. The lock lives here rather than in
  // a tab, because it has to outlive a tab switch and because the banner is
  // the only surface once the dialog is shut.
  const writeLock = useWriteLock();
  // authService keeps one client, so this is the same object every render.
  const client = user ? getClient() : null;
  // A run this page did not finish, picked back up: the service kept working
  // while the tab was away, and the result is still waiting.
  useResumedRun(client, doc, writeLock.acquire);

  // The editor's two integration spots. One instance for the whole shell, so
  // the Text Editor's dialog and the Annotate toolbar's button are the same
  // run rather than two.
  const services = useEditorServices({
    client,
    projectId,
    doc,
    project,
    acquireWriteLock: writeLock.acquire,
  });

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
  // The assistant is offered where the annotation is, which is the only tab
  // whose content it can talk about.
  const onAnnotate = pathname.endsWith('/annotate');
  const assistantAvailable = useAssistantAvailable(client, projectId);
  // A citation into THIS document scrolls the editor instead of opening a
  // second browser tab: ?sent= is the deep link the annotation editor already
  // watches, so setting it reuses the scroll and the flash.
  // Bumped on every ask, so clicking the SAME citation twice scrolls again:
  // the editor only reacts to ?sent= changing, and a repeat does not change it.
  const [focusNonce, setFocusNonce] = useState(0);
  const focusHere = useCallback(
    ({ documentId: cited, focus }) => {
      if (cited !== documentId || !focus) return false;
      setFocusNonce((k) => k + 1);
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set('sent', focus);
          return next;
        },
        { replace: true },
      );
      return true;
    },
    [documentId, setSearchParams],
  );
  const [assistantOpen, setAssistantOpen] = useState(false);
  // What the editor pointed at, as {ref, label}. It clears when it is sent.
  const [assistantFocus, setAssistantFocus] = useState(null);

  const docked = onAnnotate && assistantOpen;
  // The row fills the rest of the screen, measured rather than guessed: the
  // app header, the breadcrumbs, the tab strip and the run banner all sit
  // above it and not one of them is a fixed height.
  const rowRef = useRef(null);
  const rowHeight = useViewportFill(rowRef, docked, [writeLock.held]);

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

      {writeLock.held && (
        <div className={wide ? 'px-6' : undefined}>
          <RunBanner {...writeLock.held} />
        </div>
      )}

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

      {/* With the assistant open the editor row is bounded to the screen and
          scrolls inside itself, so the panel is exactly as tall as the viewport
          and its composer is always reachable. Closed, the page scrolls the way
          it always did. */}
      {!loading && !loadError && doc && project && (
        <div
          ref={rowRef}
          style={docked && rowHeight ? { height: rowHeight } : undefined}
          className={docked ? 'flex min-h-0' : 'flex items-start'}
        >
          <div className={docked ? 'min-w-0 flex-1 overflow-y-auto' : 'min-w-0 flex-1'}>
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
                services,
                writeLockHeld: writeLock.held,
                setChromeOffset,
                setChromeBusy,
                assistantOpen: onAnnotate ? assistantOpen : false,
                assistantAvailable,
                setAssistantOpen,
                askAssistant: setAssistantFocus,
                focusNonce,
              }}
            />
          </div>
          {onAnnotate && assistantAvailable && (
            <DocumentAssistant
              open={assistantOpen}
              onOpenChange={setAssistantOpen}
              documentId={documentId}
              documentName={doc.raw?.name}
              focus={assistantFocus}
              onClearFocus={() => setAssistantFocus(null)}
              onApplied={reload}
              onFocusHere={focusHere}
              projectId={projectId}
              projectName={project.name}
              client={client}
              userId={user?.id}
              canWrite={canEditProject(project, user)}
              contributor={!!user && isReviewed(project, user.id, { isAdmin: !!user.isAdmin })}
              adapter={UD_ASSISTANT}
            />
          )}
        </div>
      )}
    </div>
  );
};
