import { useState, useEffect, useCallback, useMemo } from 'react';
import { useParams, useLocation, Outlet } from 'react-router-dom';
import { isReviewed } from '@larc-iu/plaid-client';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { useAssistantSubject } from '@ui/components/assistant/subject.js';
import { UmrDocument } from '../../domain/UmrDocument.js';
import { useDocumentModel } from '@ui/domain/useDocumentModel.js';
import { DocumentTabs } from './DocumentTabs.jsx';
import { CommentStore } from '@ui/domain/CommentStore';
import { useCommentStore } from '@ui/domain/useCommentStore';
import { useWriteLock } from '@ui/hooks/useWriteLock.js';
import { useResumedRun } from '@ui/hooks/useResumedRun.js';
import { RunBanner } from '@ui/components/services/RunBanner.jsx';
import { useUmrServices } from './hooks/useUmrServices.js';
import { canEditProject, canManageProject } from '@ui/domain/permissions.js';
import { dismissIntegrityFindings } from '@ui/lib/integrityToast.js';
import { humanizeError } from '@ui/lib/errors.js';
import { notifyError } from '../../utils/feedback.jsx';

// Parent route of the four document tabs (/annotate, /details, /comments,
// /export). It owns the project + UmrDocument load and renders the breadcrumbs
// and the tab strip, so a tab switch swaps ONLY the body: the shell's route
// params don't change, so React Router keeps it mounted.
//
// Keeping the chrome here, above the loading gate, is the whole point of the
// shell: a tab that rendered its own copy of it behind its own gate would
// unmount the chrome on every switch, flash a bare spinner where the whole page
// had been, and re-download the document.

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
  // overlaying it. The chrome lives up here, so it has to move too: the child
  // publishes the offset through the outlet context.
  const [chromeOffset, setChromeOffset] = useState(0);
  // The tab strip is chrome, so it survives a tab switch, but it must not be
  // clickable while the body is repairing the document (see DocumentTabs). The
  // child raises this the same way it publishes its offset.
  const [chromeBusy, setChromeBusy] = useState(false);

  // One comment store per document, shared by every tab through the outlet, so
  // the Comments tab and the editor's badges read the same instance rather than
  // each loading the thread list.
  //
  // Comments are SOCIAL data, not annotation data: the store is separate from
  // UmrDocument on purpose, never bumps the document version, and is
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
    if (!comments) return;
    // Every write in the store is optimistic, so a refusal is a comment
    // vanishing from the thread again. The label is the title: it is what a
    // person scans, and the description is the reason under it.
    comments.onError = (msg, err, label) => notifyError(err ?? msg, label);
    comments.load();
  }, [comments]);

  // Re-render on any mutation of the shared document (see useDocumentModel).
  useDocumentModel(doc);

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

  // The editor's one integration spot, Draft. One instance for the whole
  // shell, so a run started on the Annotate tab keeps its lock, its banner and
  // its progress when the linguist moves to another tab.
  const services = useUmrServices({
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
        // The document is loaded with the project in hand: it writes as this
        // person against this project's layers (provenance convention).
        const projectData = await client.projects.get(projectId);
        if (cancelled) return;
        const next = await UmrDocument.load({
          client,
          documentId,
          projectId,
          project: projectData,
          user,
        });
        if (cancelled) return;
        // The label is the title, since it is what a person scans, and the
        // error is the description.
        next.onError = (msg, err, label) => notifyError(err ?? msg, label);
        setProject(projectData);
        setDoc(next);
        setLoadError('');
      } catch (err) {
        if (cancelled) return;
        if (err.status === 401) {
          logout();
          return;
        }
        setLoadError(humanizeError(err));
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

  // Resync after something outside this app changed the document (an edit to
  // its text in IGT or UD, mainly). The UmrDocument is refreshed in place so
  // the editor isn't remounted.
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

  // The integrity notice the Annotate tab raises never expires, because an
  // unrepaired document is a standing fact. It is about one DOCUMENT, not about
  // one tab: it belongs to the shell, which survives a tab switch. Leaving the
  // document, or opening another one, takes it with us.
  useEffect(() => () => dismissIntegrityFindings(), [documentId]);

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

  // What the shell's assistant panel is about while this screen is open. The
  // document is the subject on EVERY tab, not just Annotate: it is what the
  // reader is looking at either way, and the panel is the app shell's rather
  // than something one tab owns.
  //
  // No `onFocusHere`: the annotation editor has no per-sentence deep link, so
  // a citation opens the document rather than scrolling the screen behind the
  // panel.
  useAssistantSubject({
    projectId,
    projectName: project?.name,
    kind: 'document',
    id: documentId,
    name: doc?.raw?.name,
    canWrite: canEditProject(project, user),
    contributor: !!project && !!user && isReviewed(project, user.id, { isAdmin: !!user.isAdmin }),
    onApplied: reload,
    // What `@` offers in the composer: this document's sentences, by the same
    // reference the assistant writes. The hint is what the sentence SAYS,
    // because that is what a reader remembers about it rather than its number.
    mentions: () => {
      const items = (doc?.sentences || []).map((sentence) => ({
        value: `s${sentence.index}`,
        label: `s${sentence.index}`,
        hint: sentence.text,
      }));
      return items.length ? [{ group: 'Sentences', items }] : [];
    },
  });

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
            services,
            writeLockHeld: writeLock.held,
            setChromeOffset,
            setChromeBusy,
          }}
        />
      )}
    </div>
  );
};
