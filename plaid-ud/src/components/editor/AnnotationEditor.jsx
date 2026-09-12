import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { History, Info } from 'lucide-react';
import { Button } from '@ui/components/ui/button';
import { ParseDialog } from './services/ParseDialog.jsx';
import { VirtualSentenceRow } from './annotation/VirtualSentenceRow.jsx';
import { useLayerInfo } from './hooks/useLayerInfo.js';
import { useSentenceData } from './hooks/useSentenceData.js';
import { useDocumentHistory } from './hooks/useDocumentHistory.js';
import { useDocumentEditor } from './useDocumentEditor.js';
import { useReviewGestures } from './hooks/useReviewGestures.js';
import { usePrecedent } from './hooks/usePrecedent.js';
import { HistoryDrawer, HISTORY_DRAWER_WIDTH } from '@ui/components/shared/HistoryDrawer';
import { ListPager } from '@ui/components/ui/list-search';
import { usePagedList, pageKey, TALL_LIST_PAGE_SIZE } from '@ui/hooks/usePagedList';
import { RestoreDialog } from './annotation/RestoreDialog.jsx';
import { EditorLegend } from './annotation/EditorLegend.jsx';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { formatFindingsForClipboard } from '../../domain/validate.js';
import { notifyError, notifyWithAction } from '../../utils/feedback.jsx';
import { canEditProject, canManageProject } from '../../utils/permissions.js';
import { getUdLayerInfo } from '../../utils/udLayerUtils.js';
import { readMetadataFields } from '../../utils/udMetadata.js';
import { makeValidators } from '../../utils/udVocabMode.js';
import { buildAnchorIndex, anchorCaption } from '../../domain/commentAnchors.js';
import { precedentKey } from '../../domain/precedent.js';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { DocumentAssistantButton } from '@ui/components/assistant/DocumentAssistant.jsx';

// Document-wide annotation-row expansion. FEATS defaults to collapsed because its
// vertically-stacked tags inflate column widths; users expand it via its row header.
// Persisted across documents/sessions in localStorage.
const FIELD_VISIBILITY_KEY = 'ud-annotation-visible-fields';
const DEFAULT_VISIBLE_FIELDS = {
  lemma: true,
  xpos: true,
  upos: true,
  feats: false,
};

const loadVisibleFields = () => {
  try {
    const saved = JSON.parse(localStorage.getItem(FIELD_VISIBILITY_KEY));
    if (saved && typeof saved === 'object') return { ...DEFAULT_VISIBLE_FIELDS, ...saved };
  } catch {
    /* ignore malformed/absent value */
  }
  return DEFAULT_VISIBLE_FIELDS;
};

// A failed repair, said in a way the user can act on. "Could not auto-repair"
// with no reason is what a production failure looks like from the outside, and
// the usual cause on a large document is a timeout on the full-body reload
// rather than anything about the document itself.
const reconcileFailureReason = (err) => {
  if (!err) return null;
  if (/timed out/i.test(err.message || '')) return 'the request timed out';
  if (err.status === 0) return 'the server could not be reached';
  if (err.status) return `the server returned HTTP ${err.status}`;
  return err.message || null;
};

const reportReconcileFailure = (err) => {
  console.error('Reconcile-on-open failed:', err);
  const reason = reconcileFailureReason(err);
  notifyError(
    `Could not auto-repair this document. Try reloading.${reason ? ` (${reason})` : ''}`,
    'Repair failed',
  );
};

// Surface validateConlluDocument findings: full detail to the console (grouped),
// plus ONE consolidated "Data integrity issue detected" toast with a Copy
// details button. Findings are things we could NOT auto-repair, which is why
// they interrupt; repairs that SUCCEEDED say nothing (see runReconcile).
const reportIntegrityFindings = (findings, documentId) => {
  if (!findings?.length) return;
  console.group(`[plaid-ud] Document integrity findings (${findings.length})`);
  findings.forEach((f) =>
    (f.severity === 'error' ? console.error : console.warn)(`[${f.code}] ${f.message}`, f.context),
  );
  console.groupEnd();

  const errors = findings.filter((f) => f.severity === 'error');
  const headline = errors.length ? errors : findings;
  const reason =
    headline.length === 1
      ? headline[0].message
      : `${headline.length} issues found. The browser console has the details.`;
  const detail = formatFindingsForClipboard(findings, { documentId });
  notifyWithAction(reason, 'Data integrity issue detected', {
    label: 'Copy details',
    onClick: () => navigator.clipboard?.writeText(detail).catch(() => {}),
    kind: errors.length ? 'error' : 'warning',
    duration: Infinity,
  });
};

export const AnnotationEditor = () => {
  // Project, document, the breadcrumbs/tab strip and the version-counter
  // subscription all come from DocumentEditorShell, which guarantees both the
  // project and the document are loaded before this renders.
  const {
    projectId,
    documentId,
    doc,
    project,
    reload,
    comments,
    canComment,
    canDeleteAnyComment,
    services,
    writeLockHeld,
    setChromeOffset,
    setChromeBusy,
    assistantOpen,
    setAssistantOpen,
    assistantAvailable,
    askAssistant,
    focusNonce = 0,
  } = useDocumentEditor();
  // Deep link from the search page: ?sent=<sentenceTokenId> scrolls to and
  // briefly highlights that sentence once the grid is rendered.
  const [searchParams] = useSearchParams();
  const sentParam = searchParams.get('sent');
  const [flashSentId, setFlashSentId] = useState(null);
  const scrolledForRef = useRef(null);
  // History viewer state
  const [isHistoryDrawerOpen, setIsHistoryDrawerOpen] = useState(false);
  const [selectedHistoryEntry, setSelectedHistoryEntry] = useState(null);
  const [viewingHistoricalState, setViewingHistoricalState] = useState(false);
  // The history entry a restore is being confirmed for.
  const [restoreEntry, setRestoreEntry] = useState(null);

  const { getClient, user } = useAuth();
  // Reconcile-on-open is a WRITE (it can seed syntactic-words + delete
  // relations), so it must run at most once per document — otherwise StrictMode's
  // double-invoke of the mount effect would seed duplicates. Track the last
  // document we reconciled; navigation to a new doc re-arms it. `reconcileRef`
  // holds the in-flight promise so BOTH StrictMode passes await the same repair
  // before entering strict mode.
  const reconciledDocRef = useRef(null);
  const reconcileRef = useRef(null);
  // Gates the grid until the repair has finished and strict mode is on, so no
  // edit can land un-OCC-guarded in the window where a repair is still writing.
  const [reconciling, setReconciling] = useState(true);

  // Which annotation rows are expanded (document-wide). Persisted to localStorage.
  const [visibleFields, setVisibleFields] = useState(loadVisibleFields);
  useEffect(() => {
    try {
      localStorage.setItem(FIELD_VISIBILITY_KEY, JSON.stringify(visibleFields));
    } catch {
      /* ignore */
    }
  }, [visibleFields]);
  const handleToggleField = useCallback((field) => {
    setVisibleFields((prev) => ({ ...prev, [field]: !prev[field] }));
  }, []);

  useDocumentTitle('Annotate', doc?.name, project?.name);

  // Reconcile-on-open: heal UD invariants another app may have broken while
  // this editor was closed (e.g. a sentence split that left a dependency
  // relation crossing a boundary).
  //
  // Silent on success, loud on failure. A repair that worked leaves a correct
  // document and nothing for the user to do, so it goes to the console only —
  // a toast on every open just trains people to dismiss toasts. A repair that
  // FAILED, and an invariant we could not heal at all (`findings`), both still
  // interrupt: those are the cases where the document is still wrong.
  const runReconcile = useCallback(async () => {
    try {
      const {
        deletedRelations,
        createdSyntacticWords,
        deletedOrphans,
        deletedAnnotatedOrphans,
        dedupedSpans,
        findings,
        error,
      } = await doc.reconcileOnOpen();
      if (error) {
        reportReconcileFailure(error);
        return;
      }
      const parts = [];
      if (createdSyntacticWords > 0) {
        parts.push(
          `added ${createdSyntacticWords} word${createdSyntacticWords === 1 ? '' : 's'} ` +
            'to the annotation grid',
        );
      }
      if (deletedOrphans > 0) {
        let s =
          `removed ${deletedOrphans} stray word${deletedOrphans === 1 ? '' : 's'} ` +
          'that no longer matched the text';
        if (deletedAnnotatedOrphans > 0) {
          s += ` (${deletedAnnotatedOrphans} had annotations, recoverable via document history)`;
        }
        parts.push(s);
      }
      if (dedupedSpans > 0) {
        parts.push(
          `merged ${dedupedSpans} duplicate annotation${dedupedSpans === 1 ? '' : 's'} ` +
            "(values joined with ' | ', review them)",
        );
      }
      if (deletedRelations > 0) {
        parts.push(
          `removed ${deletedRelations} dependency relation${deletedRelations === 1 ? '' : 's'} that ` +
            'crossed a sentence boundary',
        );
      }
      if (parts.length) {
        console.info(`Reconcile-on-open: ${parts.join('; ')}`);
      }
      reportIntegrityFindings(findings, doc.id);
    } catch (e) {
      reportReconcileFailure(e);
    }
  }, [doc]);

  useEffect(() => {
    let cancelled = false;
    // Arm the repair once per document. Setting the ref synchronously here (not
    // inside the async body) closes the StrictMode race where both effect runs
    // pass the check before either has marked the doc reconciled — both then
    // await the SAME promise below rather than repairing twice.
    if (reconciledDocRef.current !== documentId) {
      reconciledDocRef.current = documentId;
      reconcileRef.current = canEditProject(project, user) ? runReconcile() : null;
    }
    const pending = reconcileRef.current;

    (async () => {
      if (pending) await pending;
      if (cancelled) return;
      // Strict mode OCC-guards annotation edits, and must be entered only AFTER
      // the repair's own writes have landed.
      const client = getClient();
      if (client) client.enterStrictMode(documentId);
      setReconciling(false);
    })();

    // Strict mode is client-GLOBAL, so it must be exited when we leave this
    // tab — otherwise it leaks onto unrelated writes (e.g. tokenizing in the
    // Text Editor), attaching a stale document-version and triggering spurious
    // 409s.
    return () => {
      cancelled = true;
      const client = getClient();
      if (client) client.exitStrictMode();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documentId, doc]);

  // Lock the shell's tab strip for as long as the body is a spinner. The gate
  // below keeps edits out of THIS tab while a repair is writing; without this
  // the user could simply click over to the Text Editor and re-tokenize mid-heal.
  useEffect(() => {
    setChromeBusy(reconciling);
    return () => setChromeBusy(false);
  }, [reconciling, setChromeBusy]);

  // The history drawer pushes content right rather than overlaying it. The
  // breadcrumbs and tab strip live in DocumentEditorShell now, so tell it to
  // move with us — and put it back when we leave the tab.
  useEffect(() => {
    setChromeOffset(isHistoryDrawerOpen ? HISTORY_DRAWER_WIDTH : 0);
    return () => setChromeOffset(0);
  }, [isHistoryDrawerOpen, setChromeOffset]);

  // doc-level operation errors surface as toasts (see ConlluDocument.setError);
  // a hard document-load failure is DocumentEditorShell's banner, not ours.

  // History functionality
  const {
    auditEntries,
    historicalDocument,
    loadingAudit,
    loadingHistorical,
    hasLoadedAudit,
    fetchHistoricalDocument,
    clearHistoricalDocument,
    fetchAuditLog,
  } = useDocumentHistory(documentId);

  // When viewing historical state we fall back to the legacy raw-doc render
  // path (useSentenceData still accepts a raw document and delegates to
  // ConlluDocument internally). Handlers are passed `null` in that mode, so
  // mutations stay disabled.
  const activeDocument = viewingHistoricalState ? historicalDocument : doc?.raw;

  // Read-only mode is on when the user lacks write access to the project OR
  // when time-travelling. Key the historical case on `selectedHistoryEntry`, not
  // `viewingHistoricalState`: the entry is set the instant you click (and the
  // banner appears), but `viewingHistoricalState` only flips AFTER the async
  // as-of fetch resolves. Using it would leave a window where the banner says
  // "historical" yet the live current-doc handlers are still wired — letting
  // edits land on the current document (and 409 on save).
  const canEdit = canEditProject(project, user);
  // A service run writing to this document takes the grid read-only for as
  // long as it writes: the run outlives its dialog and ends in a reload that
  // would discard anything typed underneath it. The run's OWN controls are
  // gated on `canEdit` instead, or the button carrying its progress would
  // vanish the moment the run started.
  const readOnly = !canEdit || !!selectedHistoryEntry || !!writeLockHeld;

  const historicalLayerInfo = useLayerInfo(historicalDocument);
  const layerInfo = viewingHistoricalState ? historicalLayerInfo : doc?.layerInfo;
  const historicalSentences = useSentenceData(historicalDocument);
  const processedSentences = useMemo(
    () => (viewingHistoricalState ? historicalSentences : doc?.sentences || []),
    [viewingHistoricalState, historicalSentences, doc?.sentences],
  );

  // One page of sentences in the DOM. Everything a sentence is addressed by
  // stays GLOBAL to the document — its number, its tab order, what the
  // assistant calls it — so paging changes what is rendered and nothing else.
  // The page is remembered per document, because coming back to a treebank
  // means coming back to where the work stopped.
  const paged = usePagedList(processedSentences, {
    pageSize: TALL_LIST_PAGE_SIZE,
    storageKey: pageKey('ud-annotate', documentId),
  });
  const { page, setPage } = paged;

  const indexById = useMemo(() => {
    const map = new Map();
    processedSentences.forEach((s, i) => map.set(String(s.id), i));
    return map;
  }, [processedSentences]);

  // Turn to the page a sentence is on. Every way of reaching a particular
  // sentence — the ?sent= deep link, the review sweep — has to go through this
  // first: a scroll to a row on another page finds nothing in the DOM.
  const revealSentence = useCallback(
    (sentenceId) => {
      const index = indexById.get(String(sentenceId));
      if (index == null) return;
      setPage(Math.floor(index / TALL_LIST_PAGE_SIZE));
    },
    [indexById, setPage],
  );

  // Turning the page from the bottom of the list leaves the reader at the
  // bottom of a page they have not read yet, so that pager takes them back up.
  // The top one does not, because they are already there.
  const listTopRef = useRef(null);
  const handlePageFromBottom = useCallback(
    (next) => {
      setPage(next);
      listTopRef.current?.scrollIntoView({ block: 'start' });
    },
    [setPage],
  );

  // Tab order runs across the whole document, so a sentence needs the token
  // count of every sentence before it, including the ones on other pages.
  const tokensBefore = useMemo(() => {
    const out = [];
    let total = 0;
    for (const s of processedSentences) {
      out.push(total);
      total += s.tokens.length;
    }
    return out;
  }, [processedSentences]);

  // Scroll to (and flash) the sentence named by ?sent= once, after the grid
  // has rendered. Rows are virtualized but their placeholders hold the slot, so
  // the wrapper is always in the DOM to scroll to.
  useEffect(() => {
    if (reconciling || !sentParam || !processedSentences.length) return;
    // The nonce is what lets the assistant ask for the same sentence twice:
    // without it a repeat click changes nothing and the guard swallows it.
    const asked = `${sentParam}:${focusNonce}`;
    if (scrolledForRef.current === asked) return;
    const index = indexById.get(String(sentParam));
    if (index == null) return;
    // Turn to its page first and let the effect run again: the row only exists
    // once that page has rendered. Not marked as done, so the second pass does
    // the scrolling.
    const target = Math.floor(index / TALL_LIST_PAGE_SIZE);
    if (target !== page) {
      setPage(target);
      return;
    }
    scrolledForRef.current = asked;
    const timers = [];
    const raf = requestAnimationFrame(() => {
      const selector = `[data-sentence-row="${CSS.escape(String(sentParam))}"]`;
      const bring = () =>
        document.querySelector(selector)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      bring();
      // Every row on the page is still a virtualization placeholder of its
      // estimated height at this point, and they grow to their real heights as
      // they mount — which walks the target out from under the first scroll.
      // Aim again once they have settled.
      timers.push(setTimeout(bring, 400));
      setFlashSentId(String(sentParam));
      timers.push(setTimeout(() => setFlashSentId(null), 2000));
    });
    return () => {
      cancelAnimationFrame(raf);
      timers.forEach(clearTimeout);
    };
  }, [reconciling, sentParam, processedSentences, focusNonce, indexById, page, setPage]);

  // Bind annotation/relation handlers to the current document. When viewing
  // historical state we pass `null` so VirtualSentenceRow disables editing.
  // useCallback keeps their identity stable across the transient saving
  // re-renders (isSaving/error emits), so the memoized sentence/cell subtree
  // isn't re-rendered mid-edit — otherwise focus jitters during the save.
  const handleAnnotationUpdate = useCallback(
    (tokenId, field, value) => doc?.updateAnnotation(tokenId, field, value),
    [doc],
  );
  const handleFeatureDelete = useCallback((spanId) => doc?.deleteFeature(spanId), [doc]);
  const handleRelationCreate = useCallback((s, t, dep) => doc?.createRelation(s, t, dep), [doc]);
  const handleRelationUpdate = useCallback((id, dep) => doc?.updateRelation(id, dep), [doc]);
  const handleRelationDelete = useCallback((id) => doc?.deleteRelation(id), [doc]);
  const handleConfirmTokens = useCallback((tokenIds) => doc?.confirmTokens(tokenIds), [doc]);
  const handleDiscardTokens = useCallback((tokenIds) => doc?.discardTokens(tokenIds), [doc]);
  const handleSentenceMetadata = useCallback(
    (sentenceTokenId, key, value) => doc?.setSentenceMetadata(sentenceTokenId, key, value),
    [doc],
  );

  // The sentence fields this project declares. Memoized on the project's config
  // so a sentence row memoized on its props doesn't churn per render.
  // The hand-off to the Text Editor, the mirror of Alt+click on a token there.
  const navigate = useNavigate();
  const handleEditText = useCallback(
    (sentenceTokenId) =>
      navigate(`/projects/${projectId}/documents/${documentId}/edit?sent=${sentenceTokenId}`),
    [navigate, projectId, documentId],
  );

  // What a closed vocabulary refuses, built once per layerInfo version so a
  // memoized cell subtree does not churn. Open vocabularies yield a validator
  // that always allows, which is the normal case.
  const validators = useMemo(() => makeValidators(layerInfo), [layerInfo]);

  // What this project has said before about a word like this one (Alt+Down).
  // One query per (field, key), cached for as long as the document is open.
  const lookupPrecedent = usePrecedent({
    client: getClient(),
    projectId,
    layerInfo,
    documentId,
  });
  const handlePrecedent = useCallback(
    (field, entry) => {
      const key = precedentKey(field, entry);
      return key ? lookupPrecedent(field, key) : Promise.resolve([]);
    },
    [lookupPrecedent],
  );

  // A sentence's comment badge needs the words its thread is captioned with,
  // and those come from the same anchor index the Comments tab uses. Keyed on
  // the document's DATA version, like every other derived cache here.
  const dataVersion = doc?.dataVersion ?? 0;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const anchors = useMemo(() => buildAnchorIndex(doc), [doc, dataVersion]);

  const sentenceFields = useMemo(
    () => readMetadataFields(project?.config, 'sentence'),
    [project?.config],
  );

  // The review gestures live here, not on a sentence row: every one of them can
  // cross a sentence boundary, and a row only knows its own sentence.
  const reviewKeyDown = useReviewGestures({
    sentences: processedSentences,
    doc,
    readOnly,
    visibleFields,
    revealSentence,
  });

  // History drawer handlers
  const handleOpenHistory = () => {
    setIsHistoryDrawerOpen(true);
    // Fetch audit log only when drawer is first opened
    if (!hasLoadedAudit) {
      fetchAuditLog();
    }
  };

  const handleCloseHistory = () => {
    setIsHistoryDrawerOpen(false);
    // Auto-return to current state when closing drawer
    if (selectedHistoryEntry) {
      handleSelectHistoryEntry(null);
    }
  };

  const handleSelectHistoryEntry = async (entry) => {
    if (!entry) {
      // Return to current state
      setSelectedHistoryEntry(null);
      setViewingHistoricalState(false);
      clearHistoricalDocument();
      // The as-of GET poisoned the client's strict-mode document-version tracker
      // with the OLD (historical) version. Refresh it from the live doc so the
      // next edit doesn't fail OCC with a spurious 409.
      const client = getClient();
      if (client) client.documents.get(documentId).catch(() => {});
      return;
    }

    // Set selected entry immediately for instant feedback
    const previousEntry = selectedHistoryEntry;
    setSelectedHistoryEntry(entry);

    // Fetch historical document in background
    const historicalDoc = await fetchHistoricalDocument(entry.time);
    if (historicalDoc) {
      setViewingHistoricalState(true);
    } else {
      // Time travel failed (the hook already toasts). Roll the selection back
      // so the drawer doesn't show a phantom-selected entry whose state never
      // loaded — keep showing whatever we were actually viewing before.
      setSelectedHistoryEntry(previousEntry);
    }
  };

  // After a restore (or an undo of one) the live document has changed under
  // us and the history has a new entry. Leave the historical view, then reload
  // both. Called from the toast's Undo too, long after the dialog has closed.
  const handleRestored = async () => {
    if (selectedHistoryEntry) await handleSelectHistoryEntry(null);
    await Promise.all([reload(), fetchAuditLog()]);
  };

  const hasText = !viewingHistoricalState && Boolean(activeDocument?.textLayers?.[0]?.text);

  // Single shared toolbar: History on the left, the run controls on the right.
  // Parse is the same run the Text Editor's button opens, so a parse started
  // there shows its clock here. It is gated on `canEdit` rather than on
  // `readOnly`, or the button carrying a run's progress would vanish the
  // moment that run took the lock.
  const toolbar = (
    <div className="mt-4 flex items-center justify-between gap-3">
      <Button variant="secondary" className="gap-2" onClick={handleOpenHistory}>
        <History className="h-4 w-4" />
        History
      </Button>

      <div className="flex items-center gap-3">
        {selectedHistoryEntry && <Button onClick={handleCloseHistory}>Return to current</Button>}

        <DocumentAssistantButton
          open={assistantOpen}
          onOpenChange={setAssistantOpen}
          available={assistantAvailable}
        />

        {hasText && canEdit && !selectedHistoryEntry && (
          <ParseDialog
            parse={services.parse}
            isDiscovering={services.isDiscovering}
            writeLockHeld={writeLockHeld}
          />
        )}
      </div>
    </div>
  );

  // Persistent read-only banner, shown whenever editing is disabled — either
  // because the user only has viewer access or because they're viewing a past
  // state. The message names the reason so it isn't mysterious. For time travel
  // this is the sole indicator (the toolbar chip was removed), so it carries the
  // timestamp and the loading state too, and shows as soon as an entry is picked.
  const historicalTime = selectedHistoryEntry
    ? new Date(selectedHistoryEntry.time).toLocaleString()
    : null;
  const readOnlyBanner = selectedHistoryEntry ? (
    <div className="mt-4 flex items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-900">
      {loadingHistorical ? (
        <>
          <span className="inline-block h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-amber-500/40 border-t-amber-700" />
          Loading the document as of {historicalTime}…
        </>
      ) : (
        <>
          <Info className="h-4 w-4 shrink-0" />
          Read-only. This is the document as of {historicalTime}.
        </>
      )}
    </div>
  ) : !canEdit ? (
    <div className="mt-4 flex items-center gap-2 rounded-md border border-blue-500/40 bg-blue-500/10 px-3 py-2 text-sm text-blue-900">
      <Info className="h-4 w-4 shrink-0" />
      Read-only. You have viewer access to this project.
    </div>
  ) : null;

  // Always render the main container with drawer to maintain state.
  // Reaching the editor in an unconfigured project means a link straight to
  // this URL, since clicking into the project sends you to the setup page
  // first. Say so and offer the way there, rather than redirecting: a bounce
  // out of the editor is exactly what this stopped doing.
  //
  // Read the PROJECT's layers, never the open document's. During time travel
  // `layerInfo` is the structure as it was at that moment, which for an early
  // enough entry predates the setup and is not a statement about the project.
  if (!reconciling && project && !getUdLayerInfo(project).isConfigured) {
    return (
      <div className="min-h-screen w-full">
        <div className="flex justify-center py-16">
          <div className="flex max-w-lg gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-900">
            <Info className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              <p className="font-medium">Not set up for UD</p>
              {canManageProject(project, user) ? (
                <p className="mt-1">
                  This project is not set up for Universal Dependencies.{' '}
                  <Link
                    className="font-medium underline underline-offset-2"
                    to={`/projects/${projectId}/configuration`}
                  >
                    Set up its layers
                  </Link>
                  .
                </p>
              ) : (
                <p className="mt-1">
                  This project is not set up for Universal Dependencies. A project maintainer can
                  set it up.
                </p>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen w-full">
      <HistoryDrawer
        isOpen={isHistoryDrawerOpen}
        onClose={handleCloseHistory}
        auditEntries={auditEntries}
        loading={loadingAudit}
        onSelectEntry={handleSelectHistoryEntry}
        selectedEntry={selectedHistoryEntry}
        // A restore rewrites the whole document, which is exactly what a
        // running service is doing.
        canRestore={canManageProject(project, user) && !writeLockHeld}
        onRestore={setRestoreEntry}
      />

      <RestoreDialog
        opened={!!restoreEntry}
        onClose={() => setRestoreEntry(null)}
        client={getClient()}
        documentId={documentId}
        raw={doc?.raw}
        entry={restoreEntry}
        onRestored={handleRestored}
      />

      {/* Main content area - pushed right (not overlaid) when the drawer is open */}
      <div
        className="min-h-screen transition-[margin-left] duration-300 ease-out"
        style={{ marginLeft: isHistoryDrawerOpen ? HISTORY_DRAWER_WIDTH : 0 }}
      >
        {/* Only the BODY waits here — the breadcrumbs and tab strip are the
            shell's and stay on screen throughout. */}
        {reconciling && (
          <div className="flex justify-center py-12">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-muted border-t-primary" />
          </div>
        )}

        {!reconciling && !activeDocument && (
          <p className="py-10 text-center text-muted-foreground">Document not found</p>
        )}

        {!reconciling && activeDocument && (
          <>
            <div className="px-6 pb-4">
              {toolbar}
              {readOnlyBanner}
              {processedSentences.length > 0 && !readOnly && <EditorLegend project={project} />}
              <ListPager
                {...paged}
                onPage={setPage}
                position="top"
                className="mt-4 rounded-md border"
              />
            </div>

            {processedSentences.length === 0 ? (
              <p className="py-10 text-center text-muted-foreground">
                {viewingHistoricalState
                  ? 'This state has no tokens.'
                  : 'No sentences. Tokenize the document in the Text Editor.'}
              </p>
            ) : (
              // The review gestures listen here, above every sentence, because
              // each of them can cross a sentence boundary.
              <div onKeyDown={reviewKeyDown} ref={listTopRef}>
                {paged.pageItems.map((sentenceData, offset) => {
                  // The sentence's place in the DOCUMENT, not on the page.
                  const index = page * TALL_LIST_PAGE_SIZE + offset;

                  return (
                    <div
                      key={sentenceData.id}
                      data-sentence-row={sentenceData.id}
                      className="transition-shadow duration-300"
                      style={
                        flashSentId === String(sentenceData.id)
                          ? { boxShadow: '0 0 0 3px #fcd34d', borderRadius: 6 }
                          : undefined
                      }
                    >
                      <VirtualSentenceRow
                        sentenceData={sentenceData}
                        onAnnotationUpdate={readOnly ? null : handleAnnotationUpdate}
                        onFeatureDelete={readOnly ? null : handleFeatureDelete}
                        onRelationCreate={readOnly ? null : handleRelationCreate}
                        onRelationUpdate={readOnly ? null : handleRelationUpdate}
                        onRelationDelete={readOnly ? null : handleRelationDelete}
                        onConfirmTokens={readOnly ? null : handleConfirmTokens}
                        onDiscardTokens={readOnly ? null : handleDiscardTokens}
                        onSentenceMetadata={readOnly ? null : handleSentenceMetadata}
                        onEditText={viewingHistoricalState ? null : handleEditText}
                        validators={validators}
                        comments={viewingHistoricalState ? null : comments}
                        commentAnchorLabel={anchorCaption(anchors.get(sentenceData.id))}
                        canComment={canComment}
                        canDeleteAnyComment={canDeleteAnyComment}
                        descriptions={layerInfo?.descriptions}
                        onPrecedent={readOnly ? undefined : handlePrecedent}
                        sentenceFields={sentenceFields}
                        reviewable={doc?.writer.reviewable}
                        sentenceIndex={index}
                        totalTokensBefore={tokensBefore[index] ?? 0}
                        estimatedHeight={250} // Estimated height for placeholder
                        vocab={layerInfo?.vocab}
                        colors={layerInfo?.colors}
                        visibleFields={visibleFields}
                        onToggleField={handleToggleField}
                        onAskAssistant={
                          viewingHistoricalState || !assistantAvailable ? undefined : askAssistant
                        }
                      />
                    </div>
                  );
                })}
                <ListPager
                  {...paged}
                  onPage={handlePageFromBottom}
                  className="mx-6 mb-6 rounded-md border"
                />
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
};
