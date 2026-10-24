import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Button } from '@ui/components/ui/button';
import { needsReview } from '@larc-iu/plaid-client';
import { ParseDialog } from './services/ParseDialog.jsx';
import { SentenceRow } from './annotation/SentenceRow.jsx';
import { EditorSessionContext } from './annotation/editorSession.js';
import { announceCells } from '@ui/lib/cellConflict.js';
import { wordShapeOf, wordRecutOf } from './annotation/wordShape.js';
import { useCellEngine } from '@ui/hooks/useCellEngine.js';
import { notifyWarning, notifyError } from '../../utils/feedback.jsx';
import { useUnsavedGuard } from '@ui/hooks/useUnsavedDraft.js';
import { Notice } from '@ui/components/shared/Notice.jsx';
import { useDocumentEditor } from '@ui/hooks/useDocumentEditor.js';
import { useReviewGestures } from './hooks/useReviewGestures.js';
import { routeGridTab } from './annotation/tabOrder.js';
import { useSentenceDeepLink } from './hooks/useSentenceDeepLink.js';
import { usePrecedent } from './hooks/usePrecedent.js';
import { usePagedList, pageKey, TALL_LIST_PAGE_SIZE } from '@ui/hooks/usePagedList';
import { useWideEnoughToDock } from '@ui/components/assistant/useDock.js';
import { EditorLegend } from './annotation/EditorLegend.jsx';
import { cn } from '@ui/lib/utils.js';
import { DOC_GUTTER } from '@ui/lib/pageWidth.js';
import { RunBar, RunBarPager } from '@ui/components/shared/RunBar.jsx';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { canEditProject, canManageProject, readOnlyReason } from '@ui/domain/permissions.js';
import { getUdLayerInfo } from '../../utils/udLayerUtils.js';
import { NotSetUpNotice } from '@ui/components/shared/NotSetUpNotice.jsx';
import { setupHref } from '../projects/setup.jsx';
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
    project,
    comments,
    canComment,
    canDeleteAnyComment,
    services,
    writeLockHeld,
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

  // Strict mode OCC-guards annotation edits. It is entered once the document
  // has loaded, so an edit carries the version it was made on. Opening the
  // document writes nothing (R3): a word with no UD word is made by the first
  // write on it (ConlluDocument `_makeWords`).
  useEffect(() => {
    if (doc) getClient()?.enterStrictMode(documentId);
  }, [doc, documentId, getClient]);
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
    ready: true,
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
  // A cell engine settles every field's refusal but the feature box's, which
  // has none: the document says what became of a feature (DocumentModel.cellWrite).
  const handleAnnotationUpdate = useCallback(
    (tokenId, field, value) =>
      doc
        ? doc.cellWrite(() => doc.updateAnnotation(tokenId, field, value), {
            engine: field !== 'features',
          })
        : undefined,
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
  // The address is also the href of the sentence's Edit text link.
  const navigate = useNavigate();
  const editTextHref = useCallback(
    (sentenceTokenId) =>
      `/projects/${projectId}/documents/${documentId}/edit?sent=${sentenceTokenId}`,
    [projectId, documentId],
  );
  const handleEditText = useCallback(
    (sentenceTokenId) => navigate(editTextHref(sentenceTokenId)),
    [navigate, editTextHref],
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
    let order = [];
    const read = () => {
      if (doc.dataVersion === version) return;
      version = doc.dataVersion;
      byId = new Map();
      order = [];
      for (const sentence of doc.sentences || []) {
        for (const data of sentence.tokens || []) {
          byId.set(String(data.token?.id), { data, at: order.length });
          order.push(data);
        }
      }
    };
    return (tokenId) => {
      if (!doc) return undefined;
      read();
      const hit = byId.get(String(tokenId));
      return hit && { ...hit, order };
    };
  }, [doc]);
  const cellOf = (key) => {
    const at = key.lastIndexOf(':');
    const hit = tokenData(key.slice(0, at));
    return { data: hit?.data, hit, field: key.slice(at + 1) };
  };
  const conflictContext = useRef(null);
  conflictContext.current = { client: getClient(), documentId, me: user?.id };
  const cells = useCellEngine(doc, {
    read: (key) => {
      const { data, field } = cellOf(key);
      return data ? data[field]?.value || '' : undefined;
    },
    shape: (key) => {
      const { hit } = cellOf(key);
      return hit ? wordShapeOf(hit.order, hit.at) : null;
    },
    recut: (snapshot, key) => {
      const { hit } = cellOf(key);
      return hit ? wordRecutOf(snapshot, hit.order, hit.at) : null;
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
  const confidenceThreshold = doc?.confidenceThreshold;
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
      onEditText: isViewingHistorical || !canEdit ? null : handleEditText,
      editTextHref: isViewingHistorical || !canEdit ? null : editTextHref,
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
      // Below this a machine value's mark is drawn heavier (plaid.confidence).
      confidenceThreshold,
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
      canEdit,
      handleEditText,
      editTextHref,
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
      confidenceThreshold,
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

  // Saved text with a letter in it: Parse has nothing to do with none.
  const hasText = !isViewingHistorical && Boolean(layerInfo?.textLayer?.text?.body?.trim());

  // The run controls, in the RunBar every annotation tab shares: Parse at the
  // start, the sentence count or pager after it, the gestures and marks at the
  // end. History is in the tab strip, on
  // every tab. Parse is the same run the Text Editor's button opens, so a
  // parse started there shows its clock here. It is gated on `canEdit` rather
  // than on `readOnly`, or the button carrying a run's progress would vanish
  // the moment that run took the lock. No Assistant button here: the panel is
  // app chrome and its control is in the header, on every screen. "Ask" under
  // a sentence still opens it, pointed at that sentence.
  const parseButton = hasText && canEdit && !selectedEntry && (
    <ParseDialog
      parse={services.parse}
      isDiscovering={services.isDiscovering}
      writeLockHeld={writeLockHeld}
      onOpen={services.discoverServices}
      size="sm"
    />
  );
  const toolbar = (
    <RunBar
      run={parseButton || null}
      helpLabel="Gestures and marks"
      help={processedSentences.length > 0 && !readOnly ? <EditorLegend project={project} /> : null}
    >
      <RunBarPager {...paged} onPage={setPage} />
    </RunBar>
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
  if (project && !getUdLayerInfo(project).isConfigured) {
    return (
      <div className="min-h-screen w-full">
        <div className="flex justify-center py-16">
          <NotSetUpNotice
            app="UD"
            canManage={canManageProject(project, user)}
            setupHref={setupHref(project.id)}
            className="max-w-lg p-4"
          />
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen w-full">
      {/* Only the BODY waits here: the breadcrumbs and tab strip are the
          shell's and stay on screen throughout. */}
      {!activeDocument && (
        <p className="py-10 text-center text-muted-foreground">Document not found</p>
      )}

      {activeDocument && (
        <>
          <div className={cn(DOC_GUTTER, 'pb-4')}>
            {toolbar}
            {readOnlyBanner}
          </div>

          {processedSentences.length === 0 ? (
            // One muted line and, where the reader can write, the app's own
            // outline button to the place that fixes it, as plaid-igt's
            // Analyze tab draws the same state.
            <div className="flex flex-col items-center gap-3 py-10">
              <p className="text-center text-muted-foreground">
                {isViewingHistorical
                  ? 'This state has no tokens.'
                  : 'No sentences. Parse, or tokenize in the Text Editor.'}
              </p>
              {!isViewingHistorical && !readOnly && (
                <Button asChild variant="outline" size="sm">
                  <Link to={`/projects/${projectId}/documents/${documentId}/edit`}>
                    Go to Text Editor
                  </Link>
                </Button>
              )}
            </div>
          ) : (
            // The review gestures listen here, above every sentence, because
            // each of them can cross a sentence boundary.
            <div
              onKeyDown={(event) => {
                reviewKeyDown(event);
                routeGridTab(event);
              }}
              ref={listTopRef}
            >
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
                          ? { boxShadow: '0 0 0 2px hsl(var(--ring))', borderRadius: 6 }
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
              <RunBarPager {...paged} onPage={handlePageFromBottom} position="bottom" />
            </div>
          )}
        </>
      )}
    </div>
  );
};
