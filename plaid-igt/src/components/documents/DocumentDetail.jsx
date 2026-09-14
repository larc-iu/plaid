import { useEffect, useMemo, useState, useCallback } from 'react';
import { useParams, useNavigate, useSearchParams, Link } from 'react-router-dom';
import { useStrictClient } from './contexts/StrictModeContext.jsx';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { DocumentProvider } from './contexts/DocumentContext.jsx';
import { IgtDocument } from '../../domain/IgtDocument.js';
import { readInitialized, readImportState, importRouteFor } from '@/domain/igtConfig';
import { notifyError, humanizeError } from '@/utils/feedback';
import { History, FileText, Type, Mic, Play, Table, Download, MessageSquare } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@ui/components/ui/tabs';
import { Button } from '@ui/components/ui/button';
import { ExportRunner } from '@/components/export/ExportRunner.jsx';
import { DocumentTokenize } from './tokenize/DocumentTokenize.jsx';
import { HistoryDrawer, HISTORY_DRAWER_WIDTH } from '@ui/components/shared/HistoryDrawer';
import { RestoreDialog } from './RestoreDialog.jsx';
import { DocumentMetadata } from './metadata/DocumentMetadata.jsx';
import { DocumentBaseline } from './baseline/DocumentBaseline.jsx';
import { AnalyzeIsland } from './analyze/AnalyzeIsland.jsx';
import { Suspended } from '@ui/components/shared/Suspended';
import { fullTimestamp } from '@ui/lib/formatTime.js';
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
import { useHistoryView } from './hooks/useHistoryView.js';
import { useReconcileOnOpen } from './hooks/useReconcileOnOpen.js';
import { useSentenceFocus } from './hooks/useSentenceFocus.js';
import { useDocumentTabs } from './hooks/useDocumentTabs.js';
import { useDocumentTitle } from '@ui/hooks/useDocumentTitle.js';
import { useComposeProject } from '@/hooks/useCompose';
import { useDelayedFlag } from '@/hooks/useDelayedFlag';
import { cpSlice, isReviewed } from '@larc-iu/plaid-client';
import { EdgeRail } from '@ui/components/shared/EdgeRail.jsx';
import { useAssistantSubject } from '@ui/components/assistant/subject.js';
import { useAssistantAvailable } from '@ui/components/assistant/useAssistantAvailable.js';
import { IGT_ASSISTANT } from '../projects/assistant/adapter.js';

// Renders only the active tab's panel (others stay unmounted).
const Panel = ({ active, children }) => (active ? children : null);

// The one "this document is busy" spinner.
const Spinner = ({ label, className = 'py-24' }) => (
  <div
    role="status"
    aria-live="polite"
    className={`flex flex-col items-center justify-center gap-3 ${className} text-muted-foreground`}
  >
    <div className="h-8 w-8 animate-spin rounded-full border-2 border-muted border-t-primary" />
    {label && <p className="text-sm">{label}</p>}
  </div>
);

// Tabs that get the wide column instead of the form-width one. Both are
// horizontally scrolling views -- the interlinear editor and the media
// timeline (whose content is `duration * pixelsPerSecond` wide, with the
// container acting as the viewport) -- so every extra pixel is another slice
// visible without scrolling. The form-shaped tabs stay narrow because long
// input rows are harder to read, not easier.
const WIDE_TABS = new Set(['analyze', 'media']);

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

  // The single shared IgtDocument for the whole editor. Time travel swaps it
  // for a snapshot (useHistoryView below).
  const [doc, setDoc] = useState(null);
  const [loadError, setLoadError] = useState('');

  // Base path the tab links hang their `?tab=` off.
  const docPath = `/projects/${projectId}/documents/${documentId}`;

  const permissions = useDocumentPermissions(doc?.project);

  const writeLock = useWriteLock();
  // A run the previous page started and did not live to see the end of.
  useResumedRun(client, doc, writeLock.acquire);
  // A code bound under Settings applies in the grid and every other field here.
  useComposeProject(doc?.project);
  const {
    asOf,
    isViewingHistorical,
    drawerOpen,
    openHistory,
    closeHistory,
    selectedEntry,
    selectEntry,
    auditEntries,
    loadingAudit,
    historyError,
    restoreEntry,
    setRestoreEntry,
    handleRestored,
  } = useHistoryView({
    documentId,
    client,
    doc,
    setDoc,
    onExpired: () => logout('expired'),
  });
  const [activeTab, setActiveTab, tabHref] = useDocumentTabs({ doc, asOf });
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
    comments.onError = (msg, err, label) =>
      notifyError(err ? `${label}: ${humanizeError(err)}` : humanizeError(msg, msg));
    comments.load();
  }, [comments]);

  useDocumentTitle(doc?.document?.name, doc?.project?.name);

  useEffect(() => {
    if (!client) {
      logout();
      return undefined;
    }
    let cancelled = false;
    setDoc(null);
    setLoadError('');
    (async () => {
      try {
        // The user rides along for the provenance convention: a person whose
        // work the project reviews (plaid.review) is a contributor, whose
        // edits are stamped as such (IgtDocument.contributorId).
        const d = await IgtDocument.load(client, projectId, documentId, null, { user });
        if (cancelled) return;
        d.onError = (msg, err, label) =>
          notifyError(err ? `${label}: ${humanizeError(err)}` : humanizeError(msg, msg));
        setDoc(d);
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
    // NOT keyed on asOf: time travel is useHistoryView's, and it re-reads only
    // the document. DocumentDetail is keyed by documentId, so within one mount
    // this runs once and always at the live state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, projectId, documentId, navigate, user?.id]);

  // The initial repair, and the gate the editor holds behind a spinner while it
  // runs.
  const reconciling = useReconcileOnOpen({
    doc,
    documentId,
    asOf,
    canWrite: permissions?.canWrite,
  });
  // The gate is up from the first render, but a document with nothing to heal
  // plans entirely locally and lowers it again in a microtask, so the spinner
  // is on screen for one paint on every open. Hold the tabs back on the raw
  // flag and the SPINNER on the delayed one: a pass that is over before anyone
  // could read "Checking this document…" shows nothing at all.
  const showReconcileSpinner = useDelayedFlag(reconciling);

  // The built-in analysis helpers (copy prior analyses + auto-link) no longer
  // run automatically — they were disruptive mid-editing. They run on demand
  // from the interlinear Auto-analyze dialog (see AutoAnalyzeDialog + autoPass.js).

  // The breadcrumb: pinned beside the tabs once the document is open, on its
  // own above the title while it is still being checked.
  const crumbs = (
    <nav className="flex items-center gap-1.5 text-sm text-muted-foreground">
      <Link to="/projects" className="hover:text-foreground">
        Projects
      </Link>
      <span>/</span>
      <Link to={`/projects/${projectId}`} className="hover:text-foreground">
        {doc?.project?.name || 'Project'}
      </Link>
      <span>/</span>
      <span className="text-foreground">{doc?.document?.name || 'Document'}</span>
    </nav>
  );

  if (loadError) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-8">
        <div
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive"
        >
          {loadError}
        </div>
      </div>
    );
  }

  if (!doc) {
    return <Spinner />;
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
  const readOnly = permissions.isReadOnly || isViewingHistorical || !!writeLock.held;

  return (
    <>
      {/* canRestore also waits on a run in flight: a restore rewrites the
          whole document, which is exactly what a running service is doing. */}
      <HistoryDrawer
        isOpen={drawerOpen}
        onClose={closeHistory}
        auditEntries={auditEntries}
        loading={loadingAudit}
        error={historyError}
        onSelectEntry={selectEntry}
        selectedEntry={selectedEntry}
        canRestore={permissions.canManage && !writeLock.held}
        onRestore={setRestoreEntry}
      />
      <RestoreDialog
        open={!!restoreEntry}
        onOpenChange={(o) => {
          if (!o) setRestoreEntry(null);
        }}
        client={client}
        documentId={documentId}
        doc={doc}
        entry={restoreEntry}
        onRestored={handleRestored}
      />

      {/* History rail trigger (left edge). The assistant's rail is the same
          component on the right edge (see EdgeRail). */}
      {!drawerOpen && (
        <EdgeRail
          side="left"
          label="Open history"
          title="Open history"
          onClick={openHistory}
          className="z-[1000]"
        >
          <History className="h-4 w-4 text-white opacity-0 transition-opacity group-hover:opacity-100" />
        </EdgeRail>
      )}

      {/* The PAGE scrolls, whether or not the assistant is open. The panel is
          fixed in the shell and takes a gutter on the right, so this layout no
          longer changes when it opens: no measured height, no scrollport of its
          own, and no sticky offset that depends on which element that is. */}
      <div
        className="transition-[margin] duration-200"
        style={{ marginLeft: drawerOpen ? HISTORY_DRAWER_WIDTH : 0, minHeight: '100vh' }}
      >
        <div
          className={`mx-auto px-4 py-8 ${WIDE_TABS.has(activeTab) ? 'max-w-[1700px]' : 'max-w-5xl'}`}
        >
          <div>
            <h1 className="text-3xl font-bold tracking-tight">{doc.document.name}</h1>
            {reconciling && crumbs}

            {isViewingHistorical && (
              <div className="mb-4 rounded-md border border-blue-300 bg-blue-50 px-4 py-3 text-sm text-blue-800">
                <p className="font-medium">Read-only</p>
                <p className="text-xs">This is the document as of {fullTimestamp(asOf)}.</p>
              </div>
            )}

            {!isViewingHistorical && permissions.isReadOnly && (
              <div className="mb-4 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                <p className="font-medium">Read-only</p>
                <p className="text-xs">You have viewer access to this project.</p>
              </div>
            )}

            {/* A run the linguist may well have closed the dialog on, or that
                a previous page started. Without this the document just stops
                accepting edits. */}
            {writeLock.held && <RunBanner {...writeLock.held} />}
          </div>

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
            }}
          >
            {/* The initial repair takes the tab strip's place rather than
                running underneath it: reconcile writes, so no tab may be
                opened and edited while it is still healing. The breadcrumbs
                and the title stay put above, so the page doesn't blank. */}
            {showReconcileSpinner && <Spinner label="Checking this document…" />}

            {!reconciling && (
              <Tabs value={activeTab} onValueChange={setActiveTab}>
                {/* Pinned under the app header: the way back to the project
                    and the way across the document stay in reach however far
                    down a long text you are. Asked for by the first real user
                    after scrolling back up for both, many times a day.

                    57px clears the app header. One offset now, because the page
                    is always what scrolls: the assistant used to bound this
                    container and become the scrollport, and the offset had to
                    flip negative for that, which is a whole class of bug that
                    the fixed dock removes. */}
                <div className="sticky top-[57px] z-30 -mx-4 mb-4 border-b bg-background/95 px-4 py-2 backdrop-blur supports-[backdrop-filter]:bg-background/80">
                  <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
                    {crumbs}
                    <TabsList>
                      <TabsTrigger value="metadata" to={tabHref(docPath, 'metadata')}>
                        <FileText className="h-4 w-4" /> Metadata
                      </TabsTrigger>
                      <TabsTrigger value="baseline" to={tabHref(docPath, 'baseline')}>
                        <Type className="h-4 w-4" /> Baseline
                      </TabsTrigger>
                      <TabsTrigger value="media" to={tabHref(docPath, 'media')}>
                        <Mic className="h-4 w-4" /> Media
                      </TabsTrigger>
                      <TabsTrigger value="tokenize" to={tabHref(docPath, 'tokenize')}>
                        <Play className="h-4 w-4" /> Tokenize
                      </TabsTrigger>
                      <TabsTrigger value="analyze" to={tabHref(docPath, 'analyze')}>
                        <Table className="h-4 w-4" /> Analyze
                      </TabsTrigger>
                      <TabsTrigger value="comments" to={tabHref(docPath, 'comments')}>
                        <MessageSquare className="h-4 w-4" /> Comments
                        {commentCount > 0 && (
                          <span className="ml-1 rounded-full bg-muted px-1.5 text-[10px] leading-4 tabular-nums">
                            {commentCount}
                          </span>
                        )}
                      </TabsTrigger>
                      <TabsTrigger value="export" to={tabHref(docPath, 'export')}>
                        <Download className="h-4 w-4" /> Export
                      </TabsTrigger>
                    </TabsList>
                    {/* Not a tab: history is a drawer, and it keeps whatever
                        tab you are on. But the rail at the window edge is an
                        unlabelled grey strip whose icon appears on hover, and
                        the tab bar is where a person looks for a document's
                        views, so there is a named way in here too. The
                        assistant has both in the same way. */}
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-1.5"
                      onClick={openHistory}
                      disabled={drawerOpen}
                    >
                      <History className="h-4 w-4" /> History
                    </Button>
                  </div>
                </div>

                <TabsContent value="metadata">
                  <Panel active={activeTab === 'metadata'}>
                    <DocumentMetadata />
                  </Panel>
                </TabsContent>
                <TabsContent value="baseline">
                  <Panel active={activeTab === 'baseline'}>
                    <DocumentBaseline />
                  </Panel>
                </TabsContent>
                <TabsContent value="media">
                  <Panel active={activeTab === 'media'}>
                    <Suspended>
                      <DocumentMedia />
                    </Suspended>
                  </Panel>
                </TabsContent>
                <TabsContent value="tokenize">
                  <Panel active={activeTab === 'tokenize'}>
                    <DocumentTokenize />
                  </Panel>
                </TabsContent>
                <TabsContent value="analyze">
                  <Panel active={activeTab === 'analyze'}>
                    <AnalyzeIsland />
                  </Panel>
                </TabsContent>
                <TabsContent value="comments">
                  <Panel active={activeTab === 'comments'}>
                    {isViewingHistorical ? (
                      <p className="pt-6 text-sm text-muted-foreground">
                        Comments are not shown at a past state.
                      </p>
                    ) : (
                      <Suspended>
                        <CommentsTab />
                      </Suspended>
                    )}
                  </Panel>
                </TabsContent>
                <TabsContent value="export">
                  <Panel active={activeTab === 'export'}>
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
                  </Panel>
                </TabsContent>
              </Tabs>
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
