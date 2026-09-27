import { useEffect, useMemo, useState, useCallback, useSyncExternalStore } from 'react';
import { useParams, useNavigate, useSearchParams, Link } from 'react-router-dom';
import { useStrictClient } from './contexts/StrictModeContext.jsx';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { DocumentProvider } from './contexts/DocumentContext.jsx';
import { IgtDocument } from '../../domain/IgtDocument.js';
import { readInitialized, readImportState, importRouteFor } from '@/domain/igtConfig';
import { notifyError, humanizeError } from '@/utils/feedback';
import { History } from 'lucide-react';
import { Button } from '@ui/components/ui/button';
import { DocumentTabStrip } from '@ui/components/shared/DocumentTabStrip.jsx';
import { DocumentDetailsPage } from '@ui/components/shared/DocumentDetailsPage.jsx';
import { DocumentHistoryPanel } from '@ui/components/shared/DocumentHistoryPanel.jsx';
import { Loading } from '@ui/components/shared/Loading.jsx';
import { Notice } from '@ui/components/shared/Notice.jsx';
import { ExportRunner } from '@/components/export/ExportRunner.jsx';
import { DocumentTokenize } from './tokenize/DocumentTokenize.jsx';
import { HISTORY_DRAWER_WIDTH } from '@ui/components/shared/HistoryDrawer';
import { TOKEN_ROLE_WORDS } from '@/domain/restoreSummary.js';
import { DocumentMetadata } from './metadata/DocumentMetadata.jsx';
import { DocumentBaseline } from './baseline/DocumentBaseline.jsx';
import { AnalyzeIsland } from './analyze/AnalyzeIsland.jsx';
import { Suspended } from '@ui/components/shared/Suspended';
import { lazyNamed } from '@ui/lib/lazyNamed';

// The Media tab (the timeline, waveform, speech detection, and recording
// conversion) and the Comments tab ride in their own chunks.
const DocumentMedia = lazyNamed(() => import('./media/DocumentMedia.jsx'), 'DocumentMedia');
const CommentsTab = lazyNamed(() => import('./comments/CommentsTab.jsx'), 'CommentsTab');
import { CommentStore } from '@ui/domain/CommentStore';
import { useCommentStore } from '@ui/domain/useCommentStore';
import { useDocumentPermissions } from './hooks/useDocumentPermissions.js';
import { useWriteLock } from '@ui/hooks/useWriteLock.js';
import { useResumedRun } from '@ui/hooks/useResumedRun.js';
import { RunBanner } from '@ui/components/services/RunBanner.jsx';
import { useHistoryView } from '@ui/hooks/useHistoryView.js';
import { HistoricalBanner } from '@ui/components/shared/HistoricalBanner.jsx';
import { useReconcileOnOpen } from '@ui/hooks/useReconcileOnOpen.js';
import { dismissIntegrityFindings } from '@ui/lib/integrityToast.js';
import { useSentenceFocus } from './hooks/useSentenceFocus.js';
import { useDocumentTabs } from './hooks/useDocumentTabs.js';
import { useUnsavedGuard } from '@ui/hooks/useUnsavedDraft.js';
import { useSavingGuard } from '@ui/hooks/useSavingGuard.js';
import { useDocumentTitle } from '@ui/hooks/useDocumentTitle.js';
import { useComposeProject } from '@/hooks/useCompose';
import { useDelayedFlag } from '@/hooks/useDelayedFlag';
import { cpSlice, isReviewed } from '@larc-iu/plaid-client';
import { EdgeRail } from '@ui/components/shared/EdgeRail.jsx';
import { useAssistantSubject } from '@ui/components/assistant/subject.js';
import { useAssistantAvailable } from '@ui/components/assistant/useAssistantAvailable.js';
import { IGT_ASSISTANT } from '../projects/assistant/adapter.js';

// The tabs, in the order every app keeps: the work tabs, then Comments,
// Export, Details. Each is a link to its `?tab=`.
const TABS = [
  { value: 'baseline', label: 'Baseline' },
  { value: 'media', label: 'Media' },
  { value: 'tokenize', label: 'Tokenize' },
  { value: 'analyze', label: 'Analyze' },
  { value: 'comments', label: 'Comments' },
  { value: 'export', label: 'Export' },
  { value: 'details', label: 'Details' },
];

// Tabs that get the wide column instead of the form-width one. Both are
// horizontally scrolling views -- the interlinear editor and the media
// timeline (whose content is `duration * pixelsPerSecond` wide, with the
// container acting as the viewport) -- so every extra pixel is another slice
// visible without scrolling. The form-shaped tabs stay narrow because long
// input rows are harder to read, not easier.
const WIDE_TABS = new Set(['analyze', 'media']);

const NO_SUBSCRIBE = () => () => {};

const DocumentEditor = () => {
  const { projectId, documentId } = useParams();
  const navigate = useNavigate();
  const client = useStrictClient();
  const { logout, user } = useAuth();
  const [searchParams] = useSearchParams();
  // Deep-link params: ?focusSentence=<id>&focusWord=<offset>. `?tab=` is read
  // and written by useDocumentTabs.
  const focusParam = searchParams.get('focusSentence');
  // ?focusWord= is a character offset in the text: an assistant citation names
  // the word it cites, so the link lands on the word and not just the sentence.
  const focusWordParam = Number.parseInt(searchParams.get('focusWord') ?? '', 10);

  // The live IgtDocument for the whole editor. A history entry reads a
  // snapshot beside it (useHistoryView), and `doc` is whichever is on screen.
  const [liveDoc, setLiveDoc] = useState(null);
  const [loadError, setLoadError] = useState('');
  const history = useHistoryView({
    documentId,
    client,
    doc: liveDoc,
    reload: () => liveDoc.reload(),
    onExpired: () => logout('expired'),
  });
  const {
    asOf,
    isViewingHistorical,
    loadingSnapshot,
    snapshot,
    drawerOpen,
    openHistory,
    selectedEntry,
  } = history;
  const doc = snapshot ?? liveDoc;

  // Base path the tab links hang their `?tab=` off.
  const docPath = `/projects/${projectId}/documents/${documentId}`;

  const permissions = useDocumentPermissions(doc?.project);

  const writeLock = useWriteLock();
  // A run the previous page started and did not live to see the end of.
  useResumedRun(client, doc, writeLock.acquire);
  // A code bound under Settings applies in the grid and every other field here.
  useComposeProject(doc?.project);
  const [activeTab, setActiveTab, tabHref] = useDocumentTabs({ doc, asOf });
  // What the tab showing says it would lose (`useUnsavedDraft`), and the
  // question the strip asks before leaving it. A tab that saves as you go, the
  // Analyze island and every other, says nothing and is never asked about.
  // The same question meets an in-app link and the browser's Back, from the
  // shared hook.
  const guardLeavingTab = useUnsavedGuard();
  // Opening a history entry puts the past on screen in place of what was typed
  // here and not saved, so it asks first, as leaving would.
  const selectEntry = async (entry) => {
    if (entry && !selectedEntry && !(await guardLeavingTab())) return;
    await history.selectEntry(entry);
  };
  // Landing on a sentence: the ?focusSentence= handoff, and a citation asking
  // for one of this document's sentences while the reader is here.
  const focusHere = useSentenceFocus({ documentId, focusParam, focusWordParam, activeTab });
  const project = doc?.project;
  // The island offers its own "Ask" gesture, which is only worth showing when
  // there is something to ask. The panel itself is the shell's.
  const assistantAvailable = useAssistantAvailable(client, projectId, IGT_ASSISTANT.app);
  // An applied plan rewrote the document, so the grid beside the panel is
  // stale. A fresh read at the state being viewed is the same swap the
  // restore dialog does.
  const reloadForAssistant = useCallback(async () => {
    if (!doc) return;
    // IN PLACE, not a swap for a fresh IgtDocument. The island's mount effect
    // is keyed on doc identity, so a swap tore the grid down and rebuilt it:
    // the reader lost their scroll position, the focused cell and any open
    // popover, for a change they had just approved and wanted to look at.
    // `reload` keeps the identity and emits, and the island repaints.
    await doc.reload();
  }, [doc]);

  // What the shell's assistant panel is about while this screen is open. The
  // document is the subject on EVERY tab, not just Analyze: it is what the
  // reader is looking at either way, and the panel is no longer something the
  // Analyze tab owns.
  //
  // THE ONE ORDERING RULE ON THIS SCREEN: every value this call names has to be
  // declared above it. Reading a `const` before its declaration is a TDZ throw
  // that blanks the whole screen with no console error naming the cause, and a
  // hook cannot be moved below the early returns further down.
  useAssistantSubject({
    projectId,
    projectName: project?.name,
    kind: 'document',
    id: documentId,
    name: doc?.document?.name,
    canWrite: permissions.canWrite && !isViewingHistorical,
    contributor: !!project && !!user && isReviewed(project, user.id, { isAdmin: !!user.isAdmin }),
    onApplied: reloadForAssistant,
    onFocusHere: focusHere,
    // What `@` offers in the composer: this document's sentences, by the same
    // reference Ask writes. The hint is what the sentence SAYS, because that is
    // what a reader remembers about it rather than its number.
    mentions: () => {
      // A token carries `content`, not the running text, so the hint is cut
      // from the body by the sentence's own offsets. Code points, like every
      // offset in this app.
      const body = doc?.body || '';
      const items = (doc?.sentences || []).map((sentence, i) => ({
        value: `s${i + 1}`,
        label: `s${i + 1}`,
        hint: cpSlice(body, sentence.begin, sentence.end),
      }));
      return items.length ? [{ group: 'Sentences', items }] : [];
    },
  });

  // Comments live in their own store, not on IgtDocument: they are social data,
  // they are unaudited, and they must never bump the document version. One per
  // (document, user) — the store stamps authorship and decides what is yours
  // to edit.
  const comments = useMemo(
    () =>
      client && user?.id
        ? new CommentStore({ client, projectId, documentId, currentUserId: user.id })
        : null,
    [client, projectId, documentId, user?.id],
  );
  // Subscribe the shell so the tab's badge count re-renders when a comment
  // lands. The island subscribes itself.
  useCommentStore(comments);

  const commentCount = comments?.count ?? 0;

  useEffect(() => {
    if (!comments) return undefined;
    // The label is the title: it is what a person scans, and the description
    // is the reason under it.
    comments.onError = (msg, err, label) => notifyError(err ?? msg, label);
    comments.load();
  }, [comments]);

  // The name in the heading, the breadcrumb and the window title follows a
  // rename on the Details tab. The name alone: every tab subscribes to the
  // document itself, and a screen that re-rendered on every save would take
  // all of them with it.
  const documentName = useSyncExternalStore(doc?.subscribe ?? NO_SUBSCRIBE, () => doc?.name);
  // The tab first, as in every app, so the Details page's own title and this
  // one agree, and leaving Details puts this one back.
  useDocumentTitle(
    TABS.find((t) => t.value === activeTab)?.label,
    documentName,
    doc?.project?.name,
  );

  useEffect(() => {
    if (!client) {
      logout();
      return undefined;
    }
    let cancelled = false;
    setLiveDoc(null);
    setLoadError('');
    (async () => {
      try {
        // The user rides along for the provenance convention: a person whose
        // work the project reviews (plaid.review) is a contributor, whose
        // edits are stamped as such (IgtDocument.contributorId).
        const d = await IgtDocument.load(client, projectId, documentId, null, { user });
        if (cancelled) return;
        d.onError = (msg, err, label) => notifyError(err ?? msg, label);
        setLiveDoc(d);
      } catch (e) {
        if (cancelled) return;
        if (e.message === 'Not authenticated' || e.status === 401) {
          logout('expired');
          return;
        }
        console.error('Failed to load document:', e);
        setLoadError(humanizeError(e, 'This document could not be loaded.'));
      }
    })();
    return () => {
      cancelled = true;
    };
    // NOT keyed on asOf: time travel is useHistoryView's, which reads a
    // snapshot beside this one. DocumentDetail is keyed by documentId, so
    // within one mount this runs once and always at the live state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, projectId, documentId, navigate, user?.id]);

  // The initial repair, and the gate the editor holds behind a spinner while it
  // runs.
  const reconciling = useReconcileOnOpen({ doc, asOf, canWrite: permissions?.canWrite });
  // The integrity notice is sticky so it is not missed, but it is about THIS
  // document: it goes when the reader leaves for another document or page.
  useEffect(() => () => dismissIntegrityFindings(), [documentId]);
  // Every edit shows before it is saved, so a reload or a closed tab asks
  // first while one is still on its way, here and after the reader has left for
  // another screen (the queue outlives this one). The Analyze grid asks as
  // well, for a cell typed in and not yet left.
  useSavingGuard(liveDoc);
  // Once the reader has left, a refetch after a refused edit has nothing left
  // to put right, and stops (DocumentModel.hold).
  useEffect(() => liveDoc?.hold(), [liveDoc]);
  // A comment post, edit or delete on its way, from any thread (the grid's
  // popover among them), asks the same way.
  useSavingGuard(comments);
  // The gate is up from the first render, but a document with nothing to heal
  // plans entirely locally and lowers it again in a microtask, so the spinner
  // is on screen for one paint on every open. Hold the tabs back on the raw
  // flag and the SPINNER on the delayed one: a pass that is over before anyone
  // could read "Checking this document…" shows nothing at all.
  const showReconcileSpinner = useDelayedFlag(reconciling);

  // The built-in analysis helpers (copy prior analyses + auto-link) no longer
  // run automatically — they were disruptive mid-editing. They run on demand
  // from the interlinear Auto-analyze dialog (see AutoAnalyzeDialog + autoPass.js).
  if (loadError) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-8">
        <Notice tone="error" icon={null} role="alert">
          {loadError}
        </Notice>
      </div>
    );
  }

  if (!doc) {
    return <Loading className="mx-auto max-w-5xl px-4 py-8" />;
  }

  // Same door, same reason: a project whose import never finished sends its
  // maintainers back to the wizard, and the resume DELETES the documents it
  // did not complete. Annotating one of them would be work thrown away.
  const unfinishedImport = readImportState(doc.project?.config);
  if (unfinishedImport) {
    const to = importRouteFor(unfinishedImport.kind);
    return (
      <div className="mx-auto max-w-5xl px-4 py-8">
        <div role="status" className="rounded-md border bg-muted px-4 py-3 text-sm">
          The {unfinishedImport.kind} import
          {unfinishedImport.source ? ` of “${unfinishedImport.source}”` : ''} did not finish.{' '}
          {permissions.canManage && to ? (
            <Link className="underline" to={`${to}?resume=${projectId}`}>
              Finish it
            </Link>
          ) : (
            'Ask a project maintainer to finish it.'
          )}
        </div>
      </div>
    );
  }

  // Reaching a document in a project never set up for IGT means a link
  // straight to this URL: the project door (ProjectDetail) sends a maintainer
  // to the setup wizard before they can get here. Say so and offer the way
  // there rather than redirecting, and rather than handing over an editor
  // whose fields and orthographies were never configured.
  if (!readInitialized(doc.project?.config)) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-8">
        <div role="status" className="rounded-md border bg-muted px-4 py-3 text-sm">
          {permissions.canManage ? (
            <>
              This project hasn’t been set up for IGT yet.{' '}
              <Link className="underline" to={`/projects/${projectId}/setup`}>
                Set it up
              </Link>{' '}
              to annotate it.
            </>
          ) : (
            <>
              This project hasn’t been set up for IGT yet. Ask a project maintainer to add IGT
              support.
            </>
          )}
        </div>
      </div>
    );
  }

  // A service run writing to this document takes the editor read-only for as
  // long as it writes: the run outlives its dialog, and it ends in a reload
  // that would discard anything typed underneath it. See useWriteLock.
  // Read-only from the click on a history entry, not from the snapshot landing:
  // nothing may land on the live document in the window between.
  const readOnly = permissions.isReadOnly || !!selectedEntry || !!writeLock.held;

  return (
    <>
      {/* canRestore also waits on a run in flight: a restore rewrites the
          whole document, which is exactly what a running service is doing. */}
      <DocumentHistoryPanel
        history={{ ...history, selectEntry }}
        client={client}
        documentId={documentId}
        raw={liveDoc?.raw}
        canRestore={permissions.canManage && !writeLock.held}
        roleWords={TOKEN_ROLE_WORDS}
      />

      {/* History rail trigger (left edge). The assistant's rail is the same
          component on the right edge (see EdgeRail). */}
      {!drawerOpen && (
        <EdgeRail
          side="left"
          label="Open history"
          title="Open history"
          onClick={openHistory}
          className="z-30"
        >
          <History className="h-4 w-4 text-white opacity-0 transition-opacity group-hover:opacity-100" />
        </EdgeRail>
      )}

      {/* The PAGE scrolls, whether or not the assistant is open. The panel is
          fixed in the shell and takes a gutter on the right, so this layout no
          longer changes when it opens: no measured height, no scrollport of its
          own, and no sticky offset that depends on which element that is.

          The tab row is pinned under the app header (57px, the header being
          pinned itself): the way across the document stays in reach however
          far down a long text you are. Asked for by the first real user. */}
      <div
        className="transition-[margin] duration-200"
        style={{
          marginLeft: drawerOpen ? HISTORY_DRAWER_WIDTH : 0,
          minHeight: '100vh',
          '--plaid-sticky-top': '57px',
        }}
      >
        <div
          className={`mx-auto px-4 py-8 ${WIDE_TABS.has(activeTab) ? 'max-w-[1700px]' : 'max-w-5xl'}`}
        >
          {/* While the initial repair runs the tabs are inert and the body
              waits: reconcile writes, so no tab may be opened and edited while
              it is still healing. The strip stays put, so the page doesn't
              blank. */}
          <DocumentTabStrip
            projectId={projectId}
            project={doc.project}
            document={doc.document}
            tabs={TABS.map((t) => ({
              ...t,
              to: tabHref(docPath, t.value),
              count: t.value === 'comments' ? commentCount : 0,
            }))}
            active={activeTab}
            disabled={reconciling}
            sticky
            actions={
              // Not a tab: history is a drawer, and it keeps whatever tab you
              // are on. The rail at the window edge is an unlabelled grey strip
              // whose icon appears on hover, so this is the named way in.
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5"
                onClick={openHistory}
                disabled={drawerOpen || reconciling}
              >
                <History className="h-4 w-4" /> History
              </Button>
            }
          />

          <HistoricalBanner entry={selectedEntry} loading={loadingSnapshot} className="mb-4" />

          {!isViewingHistorical && permissions.isReadOnly && (
            <Notice tone="info" className="mb-4">
              <p className="font-medium">Read-only</p>
              <p className="text-xs">You have reader access to this project.</p>
            </Notice>
          )}

          {/* A run the linguist may well have closed the dialog on, or that
              a previous page started. Without this the document just stops
              accepting edits. */}
          {writeLock.held && <RunBanner {...writeLock.held} />}

          <DocumentProvider
            value={{
              doc,
              client,
              readOnly,
              asOf,
              comments,
              // Whether this user may edit at all, ignoring any run in flight.
              // What gates a run's own controls, so the button carrying its
              // progress does not vanish the moment the run starts.
              canWrite: permissions.canWrite && !isViewingHistorical,
              canManage: permissions.canManage,
              writeLock: writeLock.held,
              acquireWriteLock: writeLock.acquire,
              assistantOnline: !!assistantAvailable,
              // How a tab sends the reader to another tab. The window event
              // the island uses stays the island's: it is not React and has no
              // context to read.
              goToTab: setActiveTab,
            }}
          >
            {showReconcileSpinner && <Loading label="Checking this document…" className="px-0" />}

            {/* Only the active tab's body is mounted. */}
            {!reconciling && (
              <div className="pt-2">
                {activeTab === 'baseline' && <DocumentBaseline />}
                {activeTab === 'media' && (
                  <Suspended>
                    <DocumentMedia />
                  </Suspended>
                )}
                {activeTab === 'tokenize' && <DocumentTokenize />}
                {activeTab === 'analyze' && <AnalyzeIsland />}
                {activeTab === 'comments' &&
                  (isViewingHistorical ? (
                    <p className="pt-6 text-sm text-muted-foreground">
                      Comments are not shown at a past state.
                    </p>
                  ) : (
                    <Suspended>
                      <CommentsTab />
                    </Suspended>
                  ))}
                {activeTab === 'export' && (
                  <div className="flex flex-col gap-6 pt-4">
                    <div className="rounded-lg border bg-card p-4">
                      <ExportRunner
                        client={client}
                        project={doc.project}
                        defaultScope={{ type: 'document', id: doc.id, name: doc.document.name }}
                        canManage={permissions.canManage}
                        asOf={asOf}
                      />
                    </div>
                  </div>
                )}
                {activeTab === 'details' && (
                  <div className="pt-4">
                    <DocumentDetailsPage
                      metadata={DocumentMetadata}
                      context={{
                        projectId,
                        documentId,
                        doc,
                        project: doc.project,
                        pastEntry: selectedEntry,
                        writeLockHeld: writeLock.held,
                      }}
                    />
                  </div>
                )}
              </div>
            )}
          </DocumentProvider>
        </div>
      </div>
    </>
  );
};

// Key the editor by documentId so navigating between documents remounts it with
// fresh state — otherwise the history rail (audit log / hasLoadedAudit) and the
// time-travel asOf would leak from the previous document (e.g. doc B loading at
// doc A's snapshot). The active tab is URL state now, so it resets with the
// query string rather than with this key.
export const DocumentDetail = () => {
  const { documentId } = useParams();
  return <DocumentEditor key={documentId} />;
};
