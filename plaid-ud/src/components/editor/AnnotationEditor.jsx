import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { needsReview } from '@larc-iu/plaid-client';
import { ParseDialog } from './services/ParseDialog.jsx';
import { SentenceRow } from './annotation/SentenceRow.jsx';
import { EditorSessionContext } from './annotation/editorSession.js';
import { announceCells } from '@ui/lib/cellConflict.js';
import { useCellEngine } from '@ui/hooks/useCellEngine.js';
import { notifyWarning, notifyError } from '../../utils/feedback.jsx';
import { useUnsavedGuard } from '@ui/hooks/useUnsavedDraft.js';
import { Notice } from '@ui/components/shared/Notice.jsx';
import { Loading } from '@ui/components/shared/Loading.jsx';
import { useDocumentEditor } from '@ui/hooks/useDocumentEditor.js';
import { useReviewGestures } from './hooks/useReviewGestures.js';
import { useSentenceDeepLink } from './hooks/useSentenceDeepLink.js';
import { usePrecedent } from './hooks/usePrecedent.js';
import { ListPager } from '@ui/components/shared/list-search';
import { usePagedList, pageKey, TALL_LIST_PAGE_SIZE } from '@ui/hooks/usePagedList';
import { useWideEnoughToDock } from '@ui/components/assistant/useDock.js';
import { EditorLegend } from './annotation/EditorLegend.jsx';
import { useAuth } from '../../contexts/AuthContext.jsx';
// Raised here, dismissed by DocumentEditorShell: the notice outlives this tab.
import { useReconcileOnOpen } from '@ui/hooks/useReconcileOnOpen.js';
import { canEditProject, canManageProject, readOnlyReason } from '@ui/domain/permissions.js';
import { getUdLayerInfo } from '../../utils/udLayerUtils.js';
import { readMetadataFields } from '../../utils/udMetadata.js';
import { makeValidators } from '../../utils/udVocabMode.js';
import { buildAnchorIndex, anchorCaption } from '../../domain/commentAnchors.js';
import { precedentKey } from '../../domain/precedent.js';
import { stableKey } from '@ui/domain/pendingIds.js';
import { useDocumentTitle } from '@ui/hooks/useDocumentTitle.js';

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

export const AnnotationEditor = () => {
  // Project, document, the breadcrumbs/tab strip and the version-counter
  // subscription all come from DocumentEditorShell, which guarantees both the
  // project and the document are loaded before this renders. So does history:
  // the drawer is the shell's, and `shown` is what it has on screen, the
  // snapshot a history entry named or the live document (`doc`). Handlers bind
  // to the live one and are nulled from the click on an entry, so no mutation
  // reaches either.
  const {
    projectId,
    documentId,
    doc: shown,
    liveDoc: doc,
    pastEntry: selectedEntry,
    asOf,
    project,
    comments,
    canComment,
    canDeleteAnyComment,
    services,
    writeLockHeld,
    setChromeBusy,
    assistantAvailable,
    askAssistant,
    focusNonce = 0,
  } = useDocumentEditor();
  // The snapshot has landed: what is on screen is the past, not the live
  // document.
  const isViewingHistorical = shown !== doc;
  // Ask hands the shell a reference and the shell opens the assistant panel on
  // it, so where there is no room for a panel Ask does nothing at all.
  const roomToDock = useWideEnoughToDock();
  // Deep link from the search page: ?sent=<sentenceTokenId> (or a sentence
  // number) scrolls to and briefly highlights that sentence once the grid is
  // rendered.
  const [searchParams] = useSearchParams();
  const sentParam = searchParams.get('sent');
  const { getClient, user } = useAuth();

  // The initial repair, and the gate the grid holds behind a spinner while it
  // runs. Strict mode OCC-guards annotation edits and is entered BEFORE the
  // repair, whose writes then carry the version it was planned from. A repair
  // that failed can leave the grid without the words it was to seed.
  const [repairFailed, setRepairFailed] = useState(false);
  useEffect(() => setRepairFailed(false), [doc]);
  const reconciling = useReconcileOnOpen({
    doc,
    asOf,
    canWrite: canEditProject(project, user),
    enterStrictMode: () => getClient()?.enterStrictMode(documentId),
    onFailed: () => setRepairFailed(true),
  });
  // Strict mode is client-GLOBAL, so it is exited on the way out of this tab,
  // or it leaks onto unrelated writes (tokenizing in the Text Editor),
  // attaching a stale document-version and triggering spurious 409s.
  useEffect(() => () => getClient()?.exitStrictMode(), [documentId, getClient]);

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

  // Lock the shell's tab strip for as long as the body is a spinner. The gate
  // below keeps edits out of THIS tab while a repair is writing; without this
  // the user could simply click over to the Text Editor and re-tokenize mid-heal.
  useEffect(() => {
    setChromeBusy(reconciling);
    return () => setChromeBusy(false);
  }, [reconciling, setChromeBusy]);

  // doc-level operation errors surface as toasts (see ConlluDocument.setError);
  // a hard document-load failure is DocumentEditorShell's banner, not ours.
  const activeDocument = shown?.raw;

  // Read-only mode is on when the user lacks write access to the project OR
  // when time-travelling. Key the historical case on `selectedEntry`, not
  // `isViewingHistorical`: the entry is set the instant you click (and the
  // banner appears), but `isViewingHistorical` only flips AFTER the async
  // as-of fetch resolves. Using it would leave a window where the banner says
  // "historical" yet the live current-doc handlers are still wired — letting
  // edits land on the current document (and 409 on save).
  const canEdit = canEditProject(project, user);
  // A service run writing to this document takes the grid read-only for as
  // long as it writes: the run outlives its dialog and ends in a reload that
  // would discard anything typed underneath it. The run's OWN controls are
  // gated on `canEdit` instead, or the button carrying its progress would
  // vanish the moment the run started.
  const readOnly = !canEdit || !!selectedEntry || !!writeLockHeld;

  const layerInfo = shown?.layerInfo;
  // Keyed on the rows, not the instance: a ConlluDocument mutates in place and
  // keeps its identity, and only its getters change.
  const processedSentences = useMemo(() => shown?.sentences || [], [shown?.sentences]);

  // One page of sentences in the DOM. Everything a sentence is addressed by
  // stays GLOBAL to the document — its number, its tab order, what the
  // assistant calls it — so paging changes what is rendered and nothing else.
  // The page is remembered per document, because coming back to a treebank
  // means coming back to where the work stopped, and it is in the URL
  // (`?page=`), so a reload, a bookmark or a link opens the page it named.
  const paged = usePagedList(processedSentences, {
    pageSize: TALL_LIST_PAGE_SIZE,
    storageKey: pageKey('ud-annotate', documentId),
    urlParam: 'page',
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
      // The page already shown is not turned to again: that would push a
      // second history entry of the same URL on every review jump.
      const target = Math.floor(index / TALL_LIST_PAGE_SIZE);
      if (target !== page) setPage(target);
    },
    [indexById, setPage, page],
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
  // has rendered.
  const flashSentId = useSentenceDeepLink({
    sentParam,
    focusNonce,
    ready: !reconciling,
    indexById,
    pageSize: TALL_LIST_PAGE_SIZE,
    page,
    setPage,
  });

  // Bind annotation/relation handlers to the current document. When viewing
  // historical state we pass `null` so SentenceRow disables editing.
  // useCallback keeps their identity stable across the transient saving
  // re-renders (isSaving/error emits), so the memoized sentence/cell subtree
  // isn't re-rendered mid-edit — otherwise focus jitters during the save.
  const handleAnnotationUpdate = useCallback(
    (tokenId, field, value) =>
      doc ? doc.cellWrite(() => doc.updateAnnotation(tokenId, field, value)) : undefined,
    [doc],
  );
  const handleFeatureDelete = useCallback((spanId) => doc?.deleteFeature(spanId), [doc]);
  const handleRelationCreate = useCallback((s, t, dep) => doc?.createRelation(s, t, dep), [doc]);
  const handleRelationUpdate = useCallback((id, dep) => doc?.updateRelation(id, dep), [doc]);
  const handleRelationDelete = useCallback((id) => doc?.deleteRelation(id), [doc]);
  const handleEnhancedRelationCreate = useCallback(
    (s, t, dep) => doc?.createEnhancedRelation(s, t, dep),
    [doc],
  );
  const handleRelationSuppress = useCallback(
    (id, suppressed) => doc?.setRelationSuppressed(id, suppressed),
    [doc],
  );
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

  // What becomes of a cell's refused edit, for the whole grid (plaid-ui
  // cells/CellEngine.js), so a value put back on a page the reader has turned
  // away from waits for its cell and still counts as typed and not saved. A
  // value refused over one someone else has stored since is a conflict, and a
  // toast names who changed it and to what. One per document: another
  // document is another grid. A cell's key is `<token id>:<field>`, split at
  // its last colon.
  // Read when an answer comes, which can be before this component has drawn
  // the document it answers about, so it goes by the document's own version.
  const tokenData = useMemo(() => {
    let version = -1;
    let byId = new Map();
    return (tokenId) => {
      if (!doc) return undefined;
      if (doc.dataVersion !== version) {
        version = doc.dataVersion;
        byId = new Map();
        for (const sentence of doc.sentences || []) {
          for (const data of sentence.tokens || []) byId.set(String(data.token?.id), data);
        }
      }
      return byId.get(String(tokenId));
    };
  }, [doc]);
  const cellOf = (key) => {
    const at = key.lastIndexOf(':');
    return { data: tokenData(key.slice(0, at)), field: key.slice(at + 1) };
  };
  // A word split or joined since a value was typed for it: its text, or how
  // much of it the token covers, changed.
  const shapeOf = (data) => `${data.wordForm}\u0000${data.token.end - data.token.begin}`;
  const conflictContext = useRef(null);
  conflictContext.current = { client: getClient(), documentId, me: user?.id };
  const cells = useCellEngine(doc, {
    read: (key) => {
      const { data, field } = cellOf(key);
      return data ? data[field]?.value || '' : undefined;
    },
    shape: (key) => {
      const { data } = cellOf(key);
      return data ? shapeOf(data) : null;
    },
    recut: (snapshot, key) => {
      const { data } = cellOf(key);
      return snapshot != null && data && shapeOf(data) !== snapshot
        ? { unit: 'word', text: data.wordForm, ids: [data.token.id] }
        : null;
    },
    entityIds: (key) => {
      const { data, field } = cellOf(key);
      return [data?.[field]?.id];
    },
    announce: announceCells({
      get client() {
        return conflictContext.current.client;
      },
      get documentId() {
        return conflictContext.current.documentId;
      },
      get me() {
        return conflictContext.current.me;
      },
      warn: (message) => notifyWarning(message),
      error: (message, title) => notifyError(message, title),
    }),
  });
  // The question they ask before leaving is the app's confirm.
  useUnsavedGuard();

  // Everything the grid reads that is the same for every sentence in it. One
  // object, so a row's own props are the sentence and where it sits, and a cell
  // four levels down asks for what it needs rather than being handed it. Its
  // deps are exactly what it holds: a document emits on every save, including
  // the ones that change no data, and a session rebuilt on one of those would
  // re-render every cell in the middle of an edit.
  const session = useMemo(
    () => ({
      isReadOnly: readOnly,
      onAnnotationUpdate: readOnly ? null : handleAnnotationUpdate,
      onFeatureDelete: readOnly ? null : handleFeatureDelete,
      onRelationCreate: readOnly ? null : handleRelationCreate,
      onRelationUpdate: readOnly ? null : handleRelationUpdate,
      onRelationDelete: readOnly ? null : handleRelationDelete,
      onEnhancedRelationCreate: readOnly ? null : handleEnhancedRelationCreate,
      onRelationSuppress: readOnly ? null : handleRelationSuppress,
      onConfirmTokens: readOnly ? null : handleConfirmTokens,
      onDiscardTokens: readOnly ? null : handleDiscardTokens,
      onSentenceMetadata: readOnly ? null : handleSentenceMetadata,
      onEditText: isViewingHistorical ? null : handleEditText,
      onPrecedent: readOnly ? undefined : handlePrecedent,
      onAskAssistant:
        isViewingHistorical || !assistantAvailable || !roomToDock ? undefined : askAssistant,
      onToggleField: handleToggleField,
      cells,
      comments: isViewingHistorical ? null : comments,
      canComment,
      canDeleteAnyComment,
      vocab: layerInfo?.vocab,
      colors: layerInfo?.colors,
      descriptions: layerInfo?.descriptions,
      validators,
      sentenceFields,
      visibleFields,
      // A document with no writer of its own reviews machine work, which is
      // what every reader of this predicate assumed before it was one value.
      reviewable: doc?.writer.reviewable ?? needsReview,
      // Which way the tokens run. One value for the document, so a sentence
      // that happens to open with a Latin loanword does not stand backwards
      // among its neighbours.
      textDirection: doc?.textDirection ?? 'ltr',
    }),
    [
      readOnly,
      handleAnnotationUpdate,
      handleFeatureDelete,
      handleRelationCreate,
      handleRelationUpdate,
      handleRelationDelete,
      handleEnhancedRelationCreate,
      handleRelationSuppress,
      handleConfirmTokens,
      handleDiscardTokens,
      handleSentenceMetadata,
      isViewingHistorical,
      handleEditText,
      handlePrecedent,
      assistantAvailable,
      roomToDock,
      askAssistant,
      handleToggleField,
      cells,
      comments,
      canComment,
      canDeleteAnyComment,
      layerInfo,
      validators,
      sentenceFields,
      visibleFields,
      doc,
    ],
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

  const hasText = !isViewingHistorical && Boolean(activeDocument?.textLayers?.[0]?.text);

  // The run controls. History is in the tab strip, on every tab. Parse is the
  // same run the Text Editor's button opens, so a parse started there shows
  // its clock here. It is gated on `canEdit` rather than on `readOnly`, or the
  // button carrying a run's progress would vanish the moment that run took the
  // lock. No Assistant button here: the panel is app chrome and its control is
  // in the header, on every screen. "Ask" under a sentence still opens it,
  // pointed at that sentence.
  const toolbar = hasText && canEdit && !selectedEntry && (
    <div className="flex items-center justify-end gap-3">
      <ParseDialog
        parse={services.parse}
        isDiscovering={services.isDiscovering}
        writeLockHeld={writeLockHeld}
        onOpen={services.discoverServices}
      />
    </div>
  );

  // Persistent read-only notice for a reader. A past state says so in the
  // shell's banner, over every tab.
  const readOnlyBanner = !selectedEntry && !canEdit && (
    <Notice tone="info" className="mt-4">
      Read-only. {readOnlyReason(project, user)}
    </Notice>
  );

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
          <Notice tone="warning" className="max-w-lg p-4">
            <p className="font-medium">Not set up for UD</p>
            {canManageProject(project, user) ? (
              <p className="mt-1">
                This project is not set up for UD.{' '}
                <Link
                  className="font-medium underline underline-offset-2"
                  to={`/projects/${projectId}/configuration`}
                >
                  Set it up
                </Link>
                .
              </p>
            ) : (
              <p className="mt-1">
                This project is not set up for UD. A project maintainer can set it up.
              </p>
            )}
          </Notice>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen w-full">
      {/* Only the BODY waits here: the breadcrumbs and tab strip are the
          shell's and stay on screen throughout. */}
      {reconciling && <Loading label="Checking this document…" className="px-6" />}

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
              {isViewingHistorical
                ? 'This state has no tokens.'
                : repairFailed
                  ? 'The document could not be repaired. Reload the page to try again.'
                  : 'No sentences. Parse, or tokenize in the Text Editor.'}
            </p>
          ) : (
            // The review gestures listen here, above every sentence, because
            // each of them can cross a sentence boundary.
            <div onKeyDown={reviewKeyDown} ref={listTopRef}>
              <EditorSessionContext.Provider value={session}>
                {paged.pageItems.map((sentenceData, offset) => {
                  // The sentence's place in the DOCUMENT, not on the page.
                  const index = page * TALL_LIST_PAGE_SIZE + offset;

                  return (
                    <div
                      key={stableKey(sentenceData.id)}
                      data-sentence-row={sentenceData.id}
                      className="transition-shadow duration-300"
                      style={
                        flashSentId === String(sentenceData.id)
                          ? { boxShadow: '0 0 0 2px #2563eb', borderRadius: 6 }
                          : undefined
                      }
                    >
                      <SentenceRow
                        sentenceData={sentenceData}
                        commentAnchorLabel={anchorCaption(anchors.get(sentenceData.id))}
                        sentenceIndex={index}
                        totalTokensBefore={tokensBefore[index] ?? 0}
                      />
                    </div>
                  );
                })}
              </EditorSessionContext.Provider>
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
  );
};
