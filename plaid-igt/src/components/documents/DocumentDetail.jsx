import { useEffect, useMemo, useState, useRef } from 'react';
import { useParams, useNavigate, useSearchParams, Link } from 'react-router-dom';
import { useStrictClient } from './contexts/StrictModeContext.jsx';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { DocumentProvider } from './contexts/DocumentContext.jsx';
import { IgtDocument } from '../../domain/IgtDocument.js';
import { formatFindingsForClipboard } from '../../domain/validate.js';
import { notifyError, toast, humanizeError } from '@/utils/feedback';
import { History, FileText, Type, Mic, Play, Table, Download, MessageSquare } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { ExportRunner } from '@/components/export/ExportRunner.jsx';
import { DocumentTokenize } from './tokenize/DocumentTokenize.jsx';
import { HistoryDrawer } from './HistoryDrawer.jsx';
import { DocumentMetadata } from './metadata/DocumentMetadata.jsx';
import { DocumentBaseline } from './baseline/DocumentBaseline.jsx';
import { DocumentMedia } from './media/DocumentMedia.jsx';
import { AnalyzeIsland } from './analyze/AnalyzeIsland.jsx';
import { CommentsTab } from './comments/CommentsTab.jsx';
import { CommentStore } from '@/domain/CommentStore';
import { useCommentStore } from '@/domain/useCommentStore';
import { useDocumentPermissions } from './hooks/useDocumentPermissions.js';
import { useDocumentHistory } from './hooks/useDocumentHistory.js';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import { useTabParam, tabTo } from '@/hooks/useTabParam';
import { useDelayedFlag } from '@/hooks/useDelayedFlag';

// Renders only the active tab's panel (others stay unmounted).
const Panel = ({ active, children }) => (active ? children : null);

// The one "this document is busy" spinner.
const Spinner = ({ label, className = 'py-24' }) => (
  <div
    role="status"
    aria-live="polite"
    className={`tw flex flex-col items-center justify-center gap-3 ${className} text-muted-foreground`}
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

// The tab bar's inventory, in display order, and the tab a document opens on.
const TABS = ['metadata', 'baseline', 'media', 'tokenize', 'analyze', 'comments', 'export'];
const DEFAULT_TAB = 'metadata';

// Surface validateIgtDocument findings: full detail to the console (grouped),
// plus ONE consolidated "Data integrity issue detected" toast with a
// [Copy details] action that drops the lot onto the clipboard for a bug report.
// Findings are things we could NOT auto-repair, which is exactly why they are
// worth interrupting for. Repairs that SUCCEEDED say nothing: see the reconcile
// effect below.
const INTEGRITY_TOAST_ID = 'igt-integrity-findings';
const reportIntegrityFindings = (findings, documentId) => {
  if (!findings?.length) return;
  console.group(`[plaid-igt] Document integrity findings (${findings.length})`);
  findings.forEach((f) =>
    (f.severity === 'error' ? console.error : console.warn)(`[${f.code}] ${f.message}`, f.context),
  );
  console.groupEnd();

  const errors = findings.filter((f) => f.severity === 'error');
  const headline = errors.length ? errors : findings;
  const reason =
    headline.length === 1
      ? headline[0].message
      : `${headline.length} issues found. See the browser console for details.`;
  const detail = formatFindingsForClipboard(findings, { documentId });
  toast.warning('Data integrity issue detected', {
    id: INTEGRITY_TOAST_ID,
    description: reason,
    duration: Infinity,
    action: {
      label: 'Copy details',
      onClick: () => navigator.clipboard?.writeText(detail).catch(() => {}),
    },
  });
};

const DocumentEditor = () => {
  const { projectId, documentId } = useParams();
  const navigate = useNavigate();
  const client = useStrictClient();
  const { logout, user } = useAuth();
  const [searchParams] = useSearchParams();
  // Deep-link params: ?tab=analyze&focusSentence=<id>. `tab` is read (and
  // written) through useTabParam below, so the raw value is needed here only to
  // tell an explicit tab request apart from the default.
  const tabParam = searchParams.get('tab');
  const focusParam = searchParams.get('focusSentence');
  // ?focusWord= is a character offset in the text: an assistant citation names
  // the word it cites, so the link lands on the word and not just the sentence.
  const focusWordParam = Number.parseInt(searchParams.get('focusWord') ?? '', 10);

  // Seed the Analyze island's focus key from ?focusSentence= once; the island
  // consumes + clears it (StrictMode-aware). Done in render so it's set before
  // the island child mounts.
  const focusSeededRef = useRef(false);
  if (!focusSeededRef.current && focusParam) {
    focusSeededRef.current = true;
    try {
      // An in-app click-through (search) writes this key first, and its version
      // carries `begin` so the caret lands on the matched word. Both paths now
      // put the sentence in the URL, so seed only when there ISN'T already a key
      // for this same target — otherwise the URL's version would clobber the
      // richer one written a moment earlier, unless the URL names a word too.
      const existing = JSON.parse(sessionStorage.getItem('igt:focus-sentence') || 'null');
      const sameTarget =
        existing && existing.docId === documentId && existing.sentenceId === focusParam;
      const begin = Number.isInteger(focusWordParam) ? focusWordParam : null;
      if (!sameTarget || begin !== null) {
        sessionStorage.setItem(
          'igt:focus-sentence',
          JSON.stringify({ docId: documentId, sentenceId: focusParam, begin }),
        );
      }
    } catch {
      /* noop */
    }
  }

  // The single shared IgtDocument for the whole editor. `asOf` drives time-travel:
  // selecting a history entry reloads this doc at that snapshot.
  const [doc, setDoc] = useState(null);
  const [asOf, setAsOf] = useState(null);
  // The active tab lives in ?tab=, so a reload, a bookmark, and the back button
  // all keep the tab the user was on, and a search/concordance click-through
  // can open the document straight onto Analyze.
  const [activeTab, setActiveTab] = useTabParam(TABS, DEFAULT_TAB);
  const [loadError, setLoadError] = useState('');

  // Base path for the tab links (each tab is `?tab=`, the default is the bare
  // document URL).
  const docPath = `/projects/${projectId}/documents/${documentId}`;

  const permissions = useDocumentPermissions(doc?.project);
  const history = useDocumentHistory(documentId, client);

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
        const d = await IgtDocument.load(client, projectId, documentId, null);
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
    // NOT keyed on asOf: time-travel is handled by the snapshot effect below,
    // which re-reads only the document. DocumentDetail is keyed by documentId,
    // so within one mount this runs once and always at the live state.
  }, [client, projectId, documentId, navigate]);

  // Time-travel. Swaps the document to another snapshot by re-reading ONLY the
  // document, reusing the project / vocab / item levels already loaded — see
  // IgtDocument#atAsOf. Deliberately does NOT blank `doc`: the old full reload
  // unmounted the whole editor to a spinner for ~1.4s on every history click,
  // which read as a full page refresh.
  useEffect(() => {
    if (!doc) return undefined;
    // Also the exit path: selecting nothing sets asOf back to null.
    if ((doc.asOf ?? null) === (asOf ?? null)) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const next = await doc.atAsOf(asOf);
        if (cancelled) return;
        next.onError = doc.onError;
        setDoc(next);
      } catch (e) {
        if (cancelled) return;
        if (e.message === 'Not authenticated' || e.status === 401) {
          logout('expired');
          return;
        }
        console.error('Failed to load snapshot:', e);
        // Keep showing what is on screen rather than blanking the editor, and
        // put the rail back where the view actually is.
        notifyError(humanizeError(e, 'That snapshot could not be loaded.'));
        setAsOf(doc.asOf ?? null);
        history.setSelectedEntry(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [doc, asOf]);

  // Reconcile: heal IGT invariants in the shared substrate — every word token
  // must have a full-width morpheme, and no morpheme may be orphaned. This runs
  // (a) once when the document loads (to repair what another app, e.g. UD, may
  // have left), and (b) every time the user enters the Analyze tab. The
  // analyze-entry re-run is essential: word tokens created in the Tokenize tab
  // this session have no morpheme yet, and tokenization never creates one — only
  // reconcile does. Without it, freshly-tokenized words show empty "Morphemes"
  // rows until a full page reload. Edit permission only, not while time-travelling
  // (asOf is a read-only snapshot). Idempotent + single-flighted, so re-entry is
  // a cheap no-op when nothing needs healing.
  //
  // Both passes run behind a spinner rather than over a live, editable document:
  // reconcile WRITES (it seeds morphemes and deletes orphans), and letting the
  // user annotate into a document that is still being repaired invites edits
  // against tokens that are about to be deleted. The initial pass takes the tab
  // strip's place; the Analyze re-entry pass covers only that panel, and only
  // after a delay, so the common no-op re-entry stays invisible.
  const reconciledDocRef = useRef(null);
  const [reconciling, setReconciling] = useState(true);
  const [reanalyzing, setReanalyzing] = useState(false);
  const showReanalyzing = useDelayedFlag(reanalyzing);
  useEffect(() => {
    // Paths with nothing to repair still have to lower the gate, or the editor
    // waits forever on a pass that will never run.
    if (!doc || asOf || !permissions?.canWrite) {
      if (doc) setReconciling(false);
      return undefined;
    }
    const isInitial = reconciledDocRef.current !== doc;
    // After the initial pass, only re-reconcile on Analyze entry.
    if (!isInitial && activeTab !== 'analyze') return undefined;
    reconciledDocRef.current = doc;
    let cancelled = false;
    const setBusy = isInitial ? setReconciling : setReanalyzing;
    setBusy(true);
    (async () => {
      try {
        const {
          created = 0,
          deleted = 0,
          deletedAnnotatedOrphans = 0,
          dedupedSpans = 0,
          dedupedLinks = 0,
          syncedMorphTypes = 0,
          findings = [],
          error,
        } = await doc.reconcileOnOpen();
        if (cancelled) return;
        // Cached morph types re-synced from their lexicon entries (an entry's
        // type changed, or an import's allomorph type differed).
        if (syncedMorphTypes) {
          console.info(
            `Reconcile: synced ${syncedMorphTypes} morpheme type(s) from lexicon entries`,
          );
        }
        // A repair that FAILED is the user's business — it's why the document
        // may still look wrong. Name the cause: "could not repair" with no
        // reason is unactionable in production, where the usual culprit is a
        // timeout or a transport error on a large document.
        if (error) {
          notifyError(
            `Could not finish auto-repairing this document; some morphemes may be missing or out of sync. Try reloading. (${humanizeError(error)})`,
            'Repair failed',
          );
          return;
        }
        // A repair that SUCCEEDED is not. The document is now correct, there is
        // nothing for the user to do, and a toast on open only teaches them to
        // dismiss toasts. The tally goes to the console, where it stays
        // available for a bug report. Failures and un-healable findings below
        // still speak up.
        if (created + deleted + dedupedSpans + dedupedLinks > 0) {
          const parts = [];
          if (created) parts.push(`added ${created} default morpheme${created === 1 ? '' : 's'}`);
          if (deleted) {
            const note = deletedAnnotatedOrphans
              ? `matching no word, ${deletedAnnotatedOrphans} carrying annotations that are recoverable via document history`
              : 'matching no word';
            parts.push(`removed ${deleted} orphaned morpheme${deleted === 1 ? '' : 's'} (${note})`);
          }
          if (dedupedSpans) {
            parts.push(
              `merged ${dedupedSpans} duplicate annotation${dedupedSpans === 1 ? '' : 's'} from a token merge (values joined with ' | ')`,
            );
          }
          if (dedupedLinks) {
            parts.push(
              `removed ${dedupedLinks} extra vocabulary link${dedupedLinks === 1 ? '' : 's'} left on a merged word (a word links one entry, so the first was kept)`,
            );
          }
          console.info(`Reconcile: ${parts.join('; ')}`);
        }
        // Integrity findings (things we could NOT auto-repair) — console + toast.
        // Only on the initial pass per doc, so re-entering Analyze doesn't
        // re-toast the same pre-existing, un-healable issues.
        if (isInitial) reportIntegrityFindings(findings, doc.id);
      } catch (e) {
        console.error('Reconcile failed:', e);
      } finally {
        // Raise the gate however the pass ended — a repair that threw must not
        // strand the document behind a spinner. A CANCELLED pass deliberately
        // leaves the initial gate down: the run that replaces it re-arms it
        // synchronously, so clearing it here would flash the editor open in
        // between (StrictMode's double-invoke does exactly this in dev).
        if (!cancelled) setBusy(false);
      }
    })();
    return () => {
      cancelled = true;
      // If this pass was cancelled before it could report (StrictMode's dev
      // double-invoke, a quick tab switch), let the next run count as the
      // initial one again, or the integrity findings toast is never shown.
      // reconcileOnOpen itself is idempotent, so re-running is cheap.
      if (isInitial && reconciledDocRef.current === doc) reconciledDocRef.current = null;
      // The re-entry gate has no such successor when the user simply leaves
      // Analyze mid-pass, so it does have to be cleared here.
      if (!isInitial) setReanalyzing(false);
    };
  }, [doc, asOf, permissions?.canWrite, activeTab]);

  // The integrity toast is sticky (duration Infinity) so it isn't missed, but
  // it is about THIS document: drop it when the user leaves for another
  // document or page instead of letting it follow them around the app.
  useEffect(() => () => toast.dismiss(INTEGRITY_TOAST_ID), [documentId]);

  // The built-in analysis helpers (copy prior analyses + auto-link) no longer
  // run automatically — they were disruptive mid-editing. They run on demand
  // from the interlinear Auto-analyze dialog (see AutoAnalyzeDialog + autoPass.js).

  // The interlinear island is framework-agnostic; its empty-state CTA asks to
  // switch tabs via a DOM event rather than reaching into the router.
  useEffect(() => {
    const onNav = (e) => {
      const t = e.detail?.tab;
      if (t) setActiveTab(t);
    };
    window.addEventListener('igt:navigate-tab', onNav);
    return () => window.removeEventListener('igt:navigate-tab', onNav);
    // Re-subscribed when the setter changes: it closes over the current query
    // string, and a stale one would write the tab onto an outdated URL.
  }, [setActiveTab]);

  // Land on Analyze when the document is already tokenized — the work surface
  // shouldn't be buried behind Metadata. Once, on the first live load only (not
  // on time-travel reloads or after the user has navigated tabs themselves).
  const didAutoTabRef = useRef(!!tabParam); // explicit tab request wins over auto-tab
  useEffect(() => {
    if (!doc || asOf || didAutoTabRef.current) return;
    didAutoTabRef.current = true;
    try {
      // Replace, not push: the user did not ask for this tab, so the back
      // button should leave the document instead of undoing the landing.
      if ((doc.sentences || []).some((s) => s.tokens.length > 0))
        setActiveTab('analyze', { replace: true });
    } catch {
      /* derivation not ready; leave default */
    }
  }, [doc, asOf, setActiveTab]);

  const handleOpenHistory = () => {
    history.setOpen(true);
    if (!history.hasLoadedAudit) history.fetchAuditLog();
  };

  const handleSelectHistoryEntry = (entry) => {
    history.setSelectedEntry(entry);
    setAsOf(entry ? entry.time : null);
  };

  const handleCloseHistory = () => {
    history.setOpen(false);
    if (history.selectedEntry) handleSelectHistoryEntry(null);
  };

  if (loadError) {
    return (
      <div className="tw mx-auto max-w-5xl px-4 py-8">
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

  const isViewingHistorical = asOf != null;
  const readOnly = permissions.isReadOnly || isViewingHistorical;

  return (
    <>
      <HistoryDrawer
        isOpen={history.open}
        onClose={handleCloseHistory}
        auditEntries={history.auditEntries}
        loading={history.loadingAudit}
        error={history.error}
        onSelectEntry={handleSelectHistoryEntry}
        selectedEntry={history.selectedEntry}
      />

      {/* History rail trigger (left edge) */}
      {!history.open && (
        <button
          type="button"
          onClick={handleOpenHistory}
          aria-label="Open history"
          className="tw group fixed left-0 top-1/2 z-[1000] flex h-28 w-1.5 -translate-y-1/2 items-center justify-center rounded-r-md bg-neutral-400 transition-all hover:w-10 hover:bg-neutral-600"
        >
          <History className="h-4 w-4 text-white opacity-0 transition-opacity group-hover:opacity-100" />
        </button>
      )}

      <div
        className="transition-[margin] duration-200"
        style={{ marginLeft: history.open ? '400px' : '0', minHeight: '100vh' }}
      >
        <div
          className={`mx-auto px-4 py-8 ${WIDE_TABS.has(activeTab) ? 'max-w-[1700px]' : 'max-w-5xl'}`}
        >
          <div className="tw">
            <nav className="mb-4 flex items-center gap-1.5 text-sm text-muted-foreground">
              <Link to="/projects" className="hover:text-foreground">
                Projects
              </Link>
              <span>/</span>
              <Link to={`/projects/${projectId}`} className="hover:text-foreground">
                {doc.project?.name || 'Project'}
              </Link>
              <span>/</span>
              <span className="text-foreground">{doc.document?.name || 'Document'}</span>
            </nav>

            <h1 className="text-3xl font-bold tracking-tight">{doc.document.name}</h1>

            {isViewingHistorical && (
              <div className="mb-4 rounded-md border border-blue-300 bg-blue-50 px-4 py-3 text-sm text-blue-800">
                <p className="font-medium">Viewing Historical State</p>
                <p className="text-xs">Changes cannot be made while viewing historical data.</p>
              </div>
            )}

            {!isViewingHistorical && permissions.isReadOnly && (
              <div className="mb-4 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                <p className="font-medium">Read-only access</p>
                <p className="text-xs">
                  You have viewer access to this project, so changes are disabled.
                </p>
              </div>
            )}
          </div>

          <DocumentProvider
            value={{
              doc,
              client,
              readOnly,
              asOf,
              comments,
              canWrite: permissions.canWrite && !isViewingHistorical,
              canManage: permissions.canManage,
            }}
          >
            {/* The initial repair takes the tab strip's place rather than
                running underneath it: reconcile writes, so no tab may be
                opened and edited while it is still healing. The breadcrumbs
                and the title stay put above, so the page doesn't blank. */}
            {reconciling && <Spinner label="Checking this document…" />}

            {!reconciling && (
              <Tabs value={activeTab} onValueChange={setActiveTab}>
                <TabsList className="tw">
                  <TabsTrigger value="metadata" to={tabTo(docPath, 'metadata', DEFAULT_TAB)}>
                    <FileText className="h-4 w-4" /> Metadata
                  </TabsTrigger>
                  <TabsTrigger value="baseline" to={tabTo(docPath, 'baseline', DEFAULT_TAB)}>
                    <Type className="h-4 w-4" /> Baseline
                  </TabsTrigger>
                  <TabsTrigger value="media" to={tabTo(docPath, 'media', DEFAULT_TAB)}>
                    <Mic className="h-4 w-4" /> Media
                  </TabsTrigger>
                  <TabsTrigger value="tokenize" to={tabTo(docPath, 'tokenize', DEFAULT_TAB)}>
                    <Play className="h-4 w-4" /> Tokenize
                  </TabsTrigger>
                  <TabsTrigger value="analyze" to={tabTo(docPath, 'analyze', DEFAULT_TAB)}>
                    <Table className="h-4 w-4" /> Analyze
                  </TabsTrigger>
                  <TabsTrigger value="comments" to={tabTo(docPath, 'comments', DEFAULT_TAB)}>
                    <MessageSquare className="h-4 w-4" /> Comments
                    {commentCount > 0 && (
                      <span className="ml-1 rounded-full bg-muted px-1.5 text-[10px] leading-4 tabular-nums">
                        {commentCount}
                      </span>
                    )}
                  </TabsTrigger>
                  <TabsTrigger value="export" to={tabTo(docPath, 'export', DEFAULT_TAB)}>
                    <Download className="h-4 w-4" /> Export
                  </TabsTrigger>
                </TabsList>

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
                    <DocumentMedia />
                  </Panel>
                </TabsContent>
                <TabsContent value="tokenize">
                  <Panel active={activeTab === 'tokenize'}>
                    <DocumentTokenize />
                  </Panel>
                </TabsContent>
                <TabsContent value="analyze">
                  <Panel active={activeTab === 'analyze'}>
                    {/* Entering Analyze re-reconciles, because words tokenized
                      this session have no morpheme yet. Hold the island back
                      until that lands, so it can't render (and be annotated)
                      against a half-repaired morpheme layer. Nothing is drawn
                      for the first beat: the pass is usually a local no-op, and
                      a spinner that resolves in the same frame reads as a
                      flicker — see useDelayedFlag. */}
                    {reanalyzing ? (
                      showReanalyzing && <Spinner label="Preparing morphemes…" className="py-16" />
                    ) : (
                      <AnalyzeIsland />
                    )}
                  </Panel>
                </TabsContent>
                <TabsContent value="comments">
                  <Panel active={activeTab === 'comments'}>
                    {isViewingHistorical ? (
                      <p className="tw pt-6 text-sm text-muted-foreground">
                        Comments are not part of the annotation history, so they are not shown at a
                        past state. Return to the current version to read or add them.
                      </p>
                    ) : (
                      <CommentsTab />
                    )}
                  </Panel>
                </TabsContent>
                <TabsContent value="export">
                  <Panel active={activeTab === 'export'}>
                    <div className="tw flex flex-col gap-6 pt-4">
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
