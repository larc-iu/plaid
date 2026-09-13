import { useEffect, useMemo, useState, useRef, useCallback } from 'react';
import { useParams, useNavigate, useSearchParams, Link } from 'react-router-dom';
import { useStrictClient } from './contexts/StrictModeContext.jsx';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { DocumentProvider } from './contexts/DocumentContext.jsx';
import { IgtDocument } from '../../domain/IgtDocument.js';
import { formatFindingsForClipboard } from '../../domain/validate.js';
import { readInitialized, readImportState, importRouteFor } from '@/domain/igtConfig';
import { notifyError, toast, humanizeError } from '@/utils/feedback';
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
import { fullTimestamp } from '@ui/utils/formatTime';
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
import { useDocumentHistory } from './hooks/useDocumentHistory.js';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import { useTabParam, tabTo } from '@/hooks/useTabParam';
import { useComposeProject } from '@/hooks/useCompose';
import { isReviewed } from '@larc-iu/plaid-client';
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
  // The history entry a restore is being confirmed for (RestoreDialog).
  const [restoreEntry, setRestoreEntry] = useState(null);
  // The active tab lives in ?tab=, so a reload, a bookmark, and the back button
  // all keep the tab the user was on, and a search/concordance click-through
  // can open the document straight onto Analyze.
  const [activeTab, setActiveTab] = useTabParam(TABS, DEFAULT_TAB);
  const [loadError, setLoadError] = useState('');

  // Base path for the tab links (each tab is `?tab=`, the default is the bare
  // document URL).
  const docPath = `/projects/${projectId}/documents/${documentId}`;

  const permissions = useDocumentPermissions(doc?.project);

  const writeLock = useWriteLock();
  // A run the previous page started and did not live to see the end of.
  useResumedRun(client, doc, writeLock.acquire);
  // A code bound under Settings applies in the grid and every other field here.
  useComposeProject(doc?.project);
  const history = useDocumentHistory(documentId, client);
  const project = doc?.project;
  // Declared up here because the subject hook below needs it, and a hook
  // cannot move down past this component's early returns.
  const isViewingHistorical = asOf != null;
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

  // A citation into THIS document scrolls the grid instead of opening a second
  // browser tab. The island owns the scrolling, so it is asked over the same
  // window bridge its own "Ask" uses.
  const focusHere = useCallback(
    ({ documentId: cited, focus, begin }) => {
      // Only while the island is actually mounted. Claiming a citation on the
      // Export tab swallowed the link and scrolled nothing: the panel is now
      // open on every tab, and the grid only listens on one of them.
      if (cited !== documentId || !focus || activeTab !== 'analyze') return false;
      window.dispatchEvent(
        new CustomEvent('igt:focus-sentence', { detail: { documentId, focus, begin } }),
      );
      return true;
    },
    [documentId, activeTab],
  );

  // What the shell's assistant panel is about while this screen is open. The
  // document is the subject on EVERY tab, not just Analyze: it is what the
  // reader is looking at either way, and the panel is no longer something the
  // Analyze tab owns.
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
    // NOT keyed on asOf: time-travel is handled by the snapshot effect below,
    // which re-reads only the document. DocumentDetail is keyed by documentId,
    // so within one mount this runs once and always at the live state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, projectId, documentId, navigate, user?.id]);

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
    // Keyed on the document and the snapshot only; history and logout are
    // read fresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, asOf]);

  // Reconcile: heal IGT invariants in the shared substrate: no morpheme may be
  // orphaned, no token may carry duplicate spans or links. Runs once when the
  // document loads, to repair what another app (e.g. UD) may have left. Edit
  // permission only, not while time-travelling (asOf is a read-only snapshot).
  // Idempotent + single-flighted.
  //
  // It used to re-run on every entry into the Analyze tab, because words
  // tokenized this session had no morpheme yet and only reconcile made one.
  // Nothing makes one now: derive gives every word a morpheme whether or not
  // one is stored (virtualMorpheme.js), so a freshly tokenized word is ready to
  // annotate the moment it exists, and the re-entry pass had nothing left to do.
  //
  // The pass runs behind a spinner rather than over a live, editable document:
  // reconcile WRITES (it deletes orphans), and letting the user annotate into a
  // document that is still being repaired invites edits against tokens that are
  // about to be deleted. It takes the tab strip's place while it runs.
  //
  // The gate reads the DOCUMENT's asOf as well as the page's: on the way back
  // from history the page's asOf is already null while `doc` is still the
  // snapshot, and a pass over the snapshot's data would write what was missing
  // THEN into the live document, racing the pass the live document gets once
  // it arrives (the loser 409s and toasts "Repair failed").
  const reconciledDocRef = useRef(null);
  const [reconciling, setReconciling] = useState(true);
  useEffect(() => {
    // Paths with nothing to repair still have to lower the gate, or the editor
    // waits forever on a pass that will never run.
    if (!doc || asOf || doc.asOf || !permissions?.canWrite) {
      if (doc) setReconciling(false);
      return undefined;
    }
    if (reconciledDocRef.current === doc) return undefined;
    reconciledDocRef.current = doc;
    let cancelled = false;
    setReconciling(true);
    (async () => {
      try {
        const {
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
        if (deleted + dedupedSpans + dedupedLinks > 0) {
          const parts = [];
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
        reportIntegrityFindings(findings, doc.id);
      } catch (e) {
        console.error('Reconcile failed:', e);
      } finally {
        // Raise the gate however the pass ended — a repair that threw must not
        // strand the document behind a spinner. A CANCELLED pass deliberately
        // leaves the gate down: the run that replaces it re-arms it
        // synchronously, so clearing it here would flash the editor open in
        // between (StrictMode's double-invoke does exactly this in dev).
        if (!cancelled) setReconciling(false);
      }
    })();
    return () => {
      cancelled = true;
      // If this pass was cancelled before it could report (StrictMode's dev
      // double-invoke, a quick tab switch), let the next run happen, or the
      // integrity findings toast is never shown. reconcileOnOpen itself is
      // idempotent, so re-running is cheap.
      if (reconciledDocRef.current === doc) reconciledDocRef.current = null;
    };
  }, [doc, asOf, permissions?.canWrite]);

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
        isOpen={history.open}
        onClose={handleCloseHistory}
        auditEntries={history.auditEntries}
        loading={history.loadingAudit}
        error={history.error}
        onSelectEntry={handleSelectHistoryEntry}
        selectedEntry={history.selectedEntry}
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
        onRestored={async () => {
          // Back to the live state, and the history rail shows the restore as
          // its newest entry. From history the snapshot effect re-reads the
          // document; from live (the toast's Undo) it is re-read IN PLACE here,
          // since setting asOf to null again changes nothing. In place because
          // a new IgtDocument rebuilds the island and throws away the reader's
          // position in a document they have just changed and want to check.
          if (asOf != null) handleSelectHistoryEntry(null);
          else if (doc) await doc.reload();
          await history.fetchAuditLog();
        }}
      />

      {/* History rail trigger (left edge). The assistant's rail is the same
          component on the right edge — see EdgeRail. */}
      {!history.open && (
        <EdgeRail
          side="left"
          label="Open history"
          title="Open history"
          onClick={handleOpenHistory}
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
        style={{ marginLeft: history.open ? HISTORY_DRAWER_WIDTH : 0, minHeight: '100vh' }}
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
            {reconciling && <Spinner label="Checking this document…" />}

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
