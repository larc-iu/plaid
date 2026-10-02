import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useParams, useLocation, useSearchParams, Outlet } from 'react-router-dom';
import { isReviewed } from '@larc-iu/plaid-client';
import { History } from 'lucide-react';
import { Button } from '@ui/components/ui/button';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { useAskAssistant, useAssistantSubject } from '@ui/components/assistant/subject.js';
import { useAssistantAvailable } from '@ui/components/assistant/useAssistantAvailable.js';
import { UMR_ASSISTANT } from '../assistant/adapter.js';
import { UmrDocument } from '../../domain/UmrDocument.js';
import { useDocumentModel } from '@ui/domain/useDocumentModel.js';
import { DocumentTabs } from './DocumentTabs.jsx';
import { SaveStatus } from '@ui/components/shared/SaveStatus.jsx';
import { CommentStore } from '@ui/domain/CommentStore';
import { useCommentStore } from '@ui/domain/useCommentStore';
import { useWriteLock } from '@ui/hooks/useWriteLock.js';
import { useSavingGuard } from '@ui/hooks/useSavingGuard.js';
import { useResumedRun } from '@ui/hooks/useResumedRun.js';
import { RunBanner } from '@ui/components/services/RunBanner.jsx';
import { useUmrServices } from './hooks/useUmrServices.js';
import { canEditProject, canManageProject } from '@ui/domain/permissions.js';
import { dismissIntegrityFindings } from '@ui/lib/integrityToast.js';
import { humanizeError, isGone } from '@ui/lib/errors.js';
import { notifyError } from '../../utils/feedback.jsx';
import { useHistoryView } from '@ui/hooks/useHistoryView.js';
import { useUnsavedGuard } from '@ui/hooks/useUnsavedDraft.js';
import { HISTORY_DRAWER_WIDTH } from '@ui/components/shared/HistoryDrawer';
import { DocumentHistoryPanel } from '@ui/components/shared/DocumentHistoryPanel.jsx';
import { HistoricalBanner } from '@ui/components/shared/HistoricalBanner.jsx';
import { Loading } from '@ui/components/shared/Loading.jsx';
import { Notice } from '@ui/components/shared/Notice.jsx';
import { TOKEN_ROLE_WORDS, UMR_LAYER_WORDS } from '../../domain/restoreSummary.js';

// Parent route of the four document tabs (/annotate, /details, /comments,
// /export). It owns the project + UmrDocument load and renders the breadcrumbs
// and the tab strip, so a tab switch swaps ONLY the body: the shell's route
// params don't change, so React Router keeps it mounted.
//
// Keeping the chrome here, above the loading gate, is the whole point of the
// shell: a tab that rendered its own copy of it behind its own gate would
// unmount the chrome on every switch, flash a bare spinner where the whole page
// had been, and re-download the document.

// Every document tab is full width in `Layout`, so the breadcrumb and the tab
// row stand in one place whichever tab is open. The annotation editor is
// full-bleed and supplies its own padding; the others are held to a readable
// width under the tabs.
const isWideRoute = (pathname) => pathname.includes('/annotate');

// The tabs that can show the document at a past state. The others write to it
// (Compare) or hang live threads on it (Comments), so while a history entry is
// open they say they are not shown.
const showsPast = (pathname) => /\/(annotate|export|details)$/.test(pathname);

// Keyed by document, so opening another document starts from nothing: no
// history rail, no past state and no busy flag carried over from the last one.
export const DocumentEditorShell = () => {
  const { documentId } = useParams();
  return <DocumentEditor key={documentId} />;
};

const DocumentEditor = () => {
  const { projectId, documentId } = useParams();
  const { pathname } = useLocation();
  const { getClient, logout, user } = useAuth();

  const [doc, setDoc] = useState(null);
  // The document now, for the comment store's error channel, which is set once.
  const docRef = useRef(null);
  docRef.current = doc;
  const [project, setProject] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  // The tab strip is chrome, so it survives a tab switch, but it must not be
  // clickable while the body is repairing the document (see DocumentTabs). The
  // child raises this through the outlet context.
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
    // A comment refused because what it is on was deleted meanwhile: the
    // document is read again, so the deletion shows.
    comments.onError = (msg, err, label) => {
      notifyError(err ?? msg, label);
      if (isGone(err)) docRef.current?.reload();
    };
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

  // The history drawer, the entry being viewed, and the restore it can lead to.
  // The shell's, not a tab's: history is about the document, so History is in
  // the tab strip on every tab, and a past state stays open across a tab
  // switch. Every tab is handed what is on screen (`doc`, the snapshot while an
  // entry is open) and the live document beside it (`liveDoc`).
  const history = useHistoryView({ documentId, client, doc, reload, onExpired: logout });
  const pastEntry = history.selectedEntry;
  const shown = history.snapshot ?? doc;
  const onPastTab = showsPast(pathname);
  // Opening an entry puts the past on screen in place of what was typed here
  // and not saved (or takes a tab that cannot show the past off screen), so it
  // asks first, as leaving would.
  const guardLeaving = useUnsavedGuard();
  const selectEntry = async (entry) => {
    if (entry && !pastEntry && !(await guardLeaving())) return;
    await history.selectEntry(entry);
  };

  // The integrity notice the Annotate tab raises never expires, because an
  // unrepaired document is a standing fact. It is about one DOCUMENT, not about
  // one tab: it belongs to the shell, which survives a tab switch. Leaving the
  // document, or opening another one, takes it with us.
  useEffect(() => () => dismissIntegrityFindings(), [documentId]);

  // A save in flight lives only in this browser tab, so a reload or a tab
  // close asks first while one is still on its way, here and after the reader
  // has left for another screen (the write queue outlives this one). A graph
  // typed in text mode and not applied asks through its own unsaved draft.
  useSavingGuard(doc);
  // Once the reader has left, a refetch after a refused edit has nothing left
  // to put right, and stops (DocumentModel.hold).
  useEffect(() => doc?.hold(), [doc]);
  // A comment post, edit or delete on its way asks the same way.
  useSavingGuard(comments);

  // What the shell's assistant panel is about while this screen is open. The
  // document is the subject on EVERY tab, not just Annotate: it is what the
  // reader is looking at either way, and the panel is the app shell's rather
  // than something one tab owns.
  //
  // A citation into THIS document scrolls the editor instead of opening a
  // second browser tab: ?sent= (and ?var=) is the deep link the annotation
  // editor watches. The nonce makes the same citation clicked twice scroll
  // again, since the editor reacts only to a change.
  const [, setSearchParams] = useSearchParams();
  const onAnnotate = pathname.endsWith('/annotate');
  const [focusNonce, setFocusNonce] = useState(0);
  const focusHere = useCallback(
    ({ documentId: cited, focus }) => {
      if (cited !== documentId || !focus?.sentence || !onAnnotate) return false;
      setFocusNonce((k) => k + 1);
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set('sent', String(focus.sentence));
          if (focus.var) next.set('var', focus.var);
          else next.delete('var');
          return next;
        },
        { replace: true },
      );
      return true;
    },
    [documentId, onAnnotate, setSearchParams],
  );
  useAssistantSubject({
    projectId,
    projectName: project?.name,
    kind: 'document',
    id: documentId,
    name: doc?.raw?.name,
    canWrite: canEditProject(project, user) && !pastEntry,
    contributor: !!project && !!user && isReviewed(project, user.id, { isAdmin: !!user.isAdmin }),
    onApplied: reload,
    onFocusHere: focusHere,
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

  // "Ask" on a sentence is only worth drawing where there is an assistant to
  // ask. It hands the panel a {ref, label} and opens it, and goes down the
  // outlet to the canvas, as in plaid-ud.
  const assistantAvailable = useAssistantAvailable(client, projectId, UMR_ASSISTANT.app);
  const askAssistant = useAskAssistant();

  const wide = isWideRoute(pathname);

  return (
    // The drawer pushes the whole page right rather than overlaying it, the
    // chrome and the tab under it together.
    <div
      className="pt-4 transition-[margin-left] duration-300 ease-out"
      style={{ marginLeft: history.drawerOpen ? HISTORY_DRAWER_WIDTH : 0 }}
    >
      <DocumentHistoryPanel
        history={{ ...history, selectEntry }}
        client={client}
        documentId={documentId}
        raw={doc?.raw}
        // A restore rewrites the whole document, which is exactly what a
        // running service is doing.
        canRestore={canManageProject(project, user) && !writeLock.held}
        roleWords={TOKEN_ROLE_WORDS}
        layerWords={UMR_LAYER_WORDS}
      />

      {/* Chrome: rendered unconditionally, including while the document loads.
          That is what stops the tab switch from blanking the page. Straight
          in the page box, with no wrapper of its own: the pinned tab row stays
          pinned only as far down as its parent box reaches. */}
      <DocumentTabs
        projectId={projectId}
        documentId={documentId}
        project={project}
        document={shown?.raw}
        commentCount={comments?.count ?? 0}
        disabled={chromeBusy}
        status={doc ? <SaveStatus doc={doc} /> : null}
        actions={
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={history.drawerOpen ? history.closeHistory : history.openHistory}
            aria-expanded={history.drawerOpen}
            disabled={!doc || chromeBusy}
          >
            <History className="h-4 w-4" /> History
          </Button>
        }
      />

      {(pastEntry || writeLock.held) && (
        <div className={wide ? 'px-6' : 'max-w-[1320px] px-6'}>
          <HistoricalBanner entry={pastEntry} loading={history.loadingSnapshot} className="mb-4" />
          {writeLock.held && <RunBanner {...writeLock.held} />}
        </div>
      )}

      {loading && <Loading />}

      {!loading && (loadError || !doc || !project) && (
        <div className={wide ? 'px-6' : 'max-w-[1320px] px-6'}>
          <Notice tone="error" icon={null} role="alert">
            {loadError || 'Document or project not found'}
          </Notice>
        </div>
      )}

      {/* The PAGE scrolls, whether or not the assistant is open. The panel is
          fixed in the shell and takes a gutter on the right, so this layout no
          longer changes when it opens: no measured height, and no scrollport of
          its own. */}
      {!loading && !loadError && doc && project && (
        // Always this div, its class alone changing with the tab: a
        // wrapper that came and went would remount the tab under it.
        <div className={wide ? undefined : 'max-w-[1320px] px-6 pb-8'}>
          {pastEntry && !onPastTab ? (
            <p className="pt-2 text-sm text-muted-foreground">Not shown at a past state.</p>
          ) : (
            <Outlet
              context={{
                projectId,
                documentId,
                doc: shown,
                liveDoc: doc,
                pastEntry,
                asOf: history.asOf,
                project,
                reload,
                comments,
                canComment: canEditProject(project, user),
                canDeleteAnyComment: canManageProject(project, user),
                services,
                writeLockHeld: writeLock.held,
                setChromeBusy,
                focusNonce,
                assistantAvailable,
                askAssistant,
              }}
            />
          )}
        </div>
      )}
    </div>
  );
};
