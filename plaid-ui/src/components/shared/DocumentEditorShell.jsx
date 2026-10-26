import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useParams, useLocation, Outlet, useSearchParams } from 'react-router-dom';
import { History } from 'lucide-react';
import { isReviewed } from '@larc-iu/plaid-client';
import { Button } from '../ui/button';
import { useAuth } from '../../contexts/useAuth.js';
import { useDocumentModel } from '../../domain/useDocumentModel.js';
import { releaseCellEngines } from '../../domain/cells/heldCells.js';
import { SaveStatus } from './SaveStatus.jsx';
import { CommentStore } from '../../domain/CommentStore';
import { useCommentStore } from '../../domain/useCommentStore';
import { useWriteLock } from '../../hooks/useWriteLock.js';
import { useAssistantAvailable } from '../assistant/useAssistantAvailable.js';
import { useAskAssistant, useAssistantSubject } from '../assistant/subject.js';
import { useResumedRun } from '../../hooks/useResumedRun.js';
import { useSavingGuard } from '../../hooks/useSavingGuard.js';
import { useTabParam } from '../../hooks/useTabParam.js';
import { useDocumentTitle } from '../../hooks/useDocumentTitle.js';
import { useValidateOnOpen } from '../../hooks/useValidateOnOpen.js';
import { RunBanner } from '../services/RunBanner.jsx';
import { canEditProject, canManageProject } from '../../domain/permissions.js';
import { dismissIntegrityFindings } from '../../lib/integrityToast.js';
import { humanizeError, isGone, statusOf } from '../../lib/errors.js';
import { notifyError } from '../../lib/notify.js';
import { useHistoryView } from '../../hooks/useHistoryView.js';
import { useUnsavedGuard } from '../../hooks/useUnsavedDraft.js';
import { HISTORY_DRAWER_WIDTH } from './HistoryDrawer';
import { DocumentHistoryPanel } from './DocumentHistoryPanel.jsx';
import { DocumentTabStrip } from './DocumentTabStrip.jsx';
import { EdgeRail } from './EdgeRail.jsx';
import { HistoricalBanner } from './HistoricalBanner.jsx';
import { Loading } from './Loading.jsx';
import { Notice } from './Notice.jsx';
import { LongDocumentNotice } from './LongDocumentNotice.jsx';
import { isLongDocument } from '../../domain/longDocument.js';
import { DOC_GUTTER } from '../../lib/pageWidth.js';
import { cn } from '../../lib/utils.js';

// The screen of an open document in every app. It owns the project and
// document load and renders the breadcrumbs and the tab strip, so a tab switch
// swaps ONLY the body.
//
// Keeping the chrome here, above the loading gate, is the whole point of the
// shell: a tab that rendered its own copy of it behind its own gate would
// unmount the chrome on every switch, flash a bare spinner where the whole page
// had been, and re-download the document.
//
// A tab lives in one of two places, the app's choice:
// - in the PATH (plaid-ud, plaid-umr): this is the parent route of one route
//   per tab, the tab is the path's last segment, and the body is the
//   `<Outlet>`, which reads what is below as `useDocumentEditor()`. The
//   shell's route params don't change on a switch, so React Router keeps it
//   mounted.
// - in the QUERY (`?tab=`, plaid-igt): this is one route, the tab is
//   `useTabParam`'s, and the body is `app.renderTab(tab, context)`.
//
// What differs by app comes in as props (`app`):
// - `loadDocument({ client, projectId, documentId, project, user })`: the
//   app's document model, loaded. `project` is the project's read, a promise,
//   so the document can be read beside it.
// - `onDocumentError({ doc, documentId, user })`, optional: the handler for
//   the document's refusals (`doc.onError`). By default each is a toast whose
//   title is the label.
// - `useServices({ client, projectId, doc, project, acquireWriteLock })`,
//   optional: the app's service runs, a hook.
// - `assistantApp`: the app tag of the app's assistant.
// - `documentPath(projectId, documentId)`: the document's address, which a
//   tab's address extends.
// - `tabs`: `list`, the tabs in order as `{ value, label }`. `editor` is the
//   annotation editor's, which is where a citation and Ask point. `wide`
//   (`[editor]` when left out) are full-bleed and supply their own padding,
//   the rest are held to a readable width. `past` are those that can show
//   the document at a past state (the others edit it or hang live threads on
//   it, so while a history entry is open they say they are not shown).
//   `long` are those that slow down with the document's length. `query`,
//   when set, keeps the tab in `?tab=`: `{ fallback, landing(doc) }`,
//   where `landing` names the tab a document opens on when the address names
//   none (or nothing, to stay on the fallback). Every tab writes itself there,
//   the fallback included, since a bare address means "no tab chosen".
// - `renderTab(tab, context)`: the body, where the tab is in the query.
// - `validateOnOpen`: true to have the shell check the document when it
//   opens (useValidateOnOpen), for every tab. An app that checks from one tab
//   does it there. An app that repairs from one tab (plaid-umr) holds the tabs
//   inert meanwhile through `setChromeBusy`.
// - `saveStatus`: false for an app whose editor shows a save pill of its own.
// - `roleWords`, `layerWords`: History's words for the app's rows.
// - `focusParams(focus)`: the URL params a citation's focus opens, or null
//   when it names nothing on this page. Or `useFocusHere({ documentId,
//   onEditor })`, a hook answering the citation itself (`onFocusHere`).
// - `sentenceRef(sentence, i)`: the reference `@` and Ask write for a
//   sentence, and `sentenceHint(sentence, doc)` what the sentence says, where
//   it has no `text` of its own.
// - `wordCount(doc)`, optional: the length the long-document notice weighs.
// - `runNotices`, optional: `{[task]: (result) => notice}`, the app's words
//   for a run's counts by its task, for a run rejoined after a reload. The
//   same functions the app's run spots pass as `notice`.
//
// `client`, optional, is the one the document is read and written through
// where the app keeps one per document. The session's otherwise.

// The tab open, by the last segment of its path.
const tabOf = (pathname) => pathname.split('/').filter(Boolean).pop() ?? '';

const noServices = () => null;
const noFocus = () => null;
const toast = () => (msg, err, label) => notifyError(err ?? msg, label);

// Core answers an id it cannot place 403 to a member (so a non-member learns
// nothing) and 404 to an admin, and a link to a deleted document meets either.
const NOT_OPENABLE = 'This document does not exist or you cannot open it.';
const loadErrorText = (err) => {
  const status = statusOf(err);
  return status === 403 || status === 404 || isGone(err)
    ? NOT_OPENABLE
    : humanizeError(err, 'This document could not be loaded.');
};

// Keyed by document, so opening another document starts from nothing: no
// history rail, no past state and no busy flag carried over from the last one.
export const DocumentEditorShell = ({ app, client }) => {
  const { documentId } = useParams();
  return <DocumentEditor key={documentId} app={app} documentClient={client} />;
};

const DocumentEditor = ({ app, documentClient }) => {
  const { projectId, documentId } = useParams();
  const { pathname } = useLocation();
  const { getClient, logout, user } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();

  const [doc, setDoc] = useState(null);
  // The document now, for the comment store's error channel, which is set once.
  const docRef = useRef(null);
  docRef.current = doc;
  const [loadedProject, setProject] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  // The tab strip is chrome, so it survives a tab switch, but it must not be
  // clickable while the body is repairing the document (DocumentTabStrip). The
  // child raises this through the outlet context (plaid-umr's Annotate tab).
  const [chromeBusy, setChromeBusy] = useState(false);
  // authService keeps one client, so this is the same object every render.
  const client = documentClient ?? (user ? getClient() : null);

  // Which tab is open. Both hooks run in both modes, and the query's is told
  // it is not in charge (`ready`) where the tab is the path's, so it leaves a
  // `?tab=` it does not know alone.
  const query = app.tabs.query;
  const tabValues = useMemo(() => app.tabs.list.map((t) => t.value), [app]);
  const [queryTab, setQueryTab, queryHref] = useTabParam(
    tabValues,
    query?.fallback ?? tabValues[0],
    { writeFallback: true, ready: !!query },
  );
  const tab = query ? queryTab : tabOf(pathname);
  const base = app.documentPath(projectId, documentId);
  const tabHref = (value) => (query ? queryHref(base, value) : `${base}/${value}`);

  // One comment store per document, shared by every tab through the outlet, so
  // the Comments tab and the editor's badges read the same instance rather than
  // each loading the thread list.
  //
  // Comments are SOCIAL data, not annotation data: the store is separate from
  // the document model on purpose, never bumps the document version, and is
  // deliberately absent from the document read.
  // Made once the document has loaded: a document that cannot be read has
  // no comments to read either, and saying so twice is one toast too many.
  const loaded = !!doc;
  const comments = useMemo(
    () =>
      client && documentId && user?.id && loaded
        ? new CommentStore({ client, projectId, documentId, currentUserId: user.id })
        : null,
    [client, projectId, documentId, user?.id, loaded],
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
      if (isGone(err)) {
        docRef.current
          ?.reload()
          .catch((e) => console.error('Reading the document again failed:', e));
      }
    };
    comments.load();
  }, [comments]);

  // Re-render on any mutation of the shared document (see useDocumentModel).
  useDocumentModel(doc);
  // A cell's refused value, waiting to be sent again or for keep-yours, is
  // the document's for as long as it is open, whatever is drawn meanwhile
  // (domain/cells/heldCells.js). It goes when the document does.
  useEffect(() => () => releaseCellEngines(doc), [doc]);
  // The document's copy of the project once there is one: it reads it again
  // while open and after a refused write, so a member demoted or removed
  // meanwhile gets the read-only page without a reload.
  const project = doc?.project ?? loadedProject;

  // A service run that writes takes the document read-only for as long as it
  // writes: the run outlives its dialog and ends in a reload, so anything
  // typed underneath it would be discarded. The lock lives here rather than in
  // a tab, because it has to outlive a tab switch and because the banner is
  // the only surface once the dialog is shut.
  const writeLock = useWriteLock();
  // A run this page did not finish, picked back up: the service kept working
  // while the tab was away, and the result is still waiting.
  useResumedRun(client, doc, writeLock.acquire, app.runNotices);

  // The app's service runs. One instance for the whole shell, so a run started
  // on one tab keeps its lock, its banner and its progress on another.
  const useServices = app.useServices ?? noServices;
  const services = useServices({
    client,
    projectId,
    doc,
    project,
    acquireWriteLock: writeLock.acquire,
  });

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      if (!client) {
        logout();
        return;
      }
      // The document is loaded with the project and the user in hand: it
      // writes as this person against this project's layers (provenance
      // convention).
      const projectRead = client.projects.get(projectId);
      // Read on its own as well, so a document that fails to load still
      // stands under its project's name.
      projectRead.then(
        (p) => !cancelled && setProject(p),
        () => {},
      );
      try {
        setLoading(true);
        const next = await app.loadDocument({
          client,
          projectId,
          documentId,
          project: projectRead,
          user,
        });
        const projectData = await projectRead;
        if (cancelled) return;
        next.onError = (app.onDocumentError ?? toast)({ doc: next, documentId, user });
        setProject(projectData);
        setDoc(next);
        setLoadError('');
      } catch (err) {
        if (cancelled) return;
        if (err.status === 401 || err.message === 'Not authenticated') {
          logout('expired');
          return;
        }
        setLoadError(loadErrorText(err));
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

  // Resync after something outside this page changed the document (a service
  // run, the assistant). The document is refreshed in place so the editor
  // isn't remounted.
  const reload = useCallback(async () => {
    if (!client) return;
    try {
      // The document keeps the project the page reads (see `project` above).
      if (doc) await Promise.all([doc.refreshProject(), doc.reload()]);
      else setProject(await client.projects.get(projectId));
    } catch (err) {
      if (err.status === 401) {
        logout('expired');
        return;
      }
      console.error('Error refreshing document:', err);
    }
  }, [projectId, doc, client, logout]);

  // The history drawer, the entry being viewed, and the restore it can lead to.
  // The shell's, not a tab's: history is about the document, so History is in
  // the tab strip on every tab, and a past state stays open across a tab
  // switch. Every tab is handed what is on screen (`doc`, the snapshot while an
  // entry is open) and the live document beside it (`liveDoc`).
  const history = useHistoryView({
    documentId,
    client,
    doc,
    reload,
    onExpired: () => logout('expired'),
  });
  // The drawer steps the whole page right, the app header with it, rather than
  // overlaying it (AppShell reads the width, and slides on the drawer's own
  // timing).
  useEffect(() => {
    const root = window.document.documentElement;
    root.style.setProperty(
      '--plaid-history-width',
      history.drawerOpen ? `${HISTORY_DRAWER_WIDTH}px` : '0px',
    );
    return () => root.style.removeProperty('--plaid-history-width');
  }, [history.drawerOpen]);
  const pastEntry = history.selectedEntry;
  const shown = history.snapshot ?? doc;
  const onPastTab = app.tabs.past.includes(tab);
  // Opening an entry puts the past on screen in place of what was typed here
  // and not saved (or takes a tab that cannot show the past off screen), so it
  // asks first, as leaving would.
  const guardLeaving = useUnsavedGuard();
  const selectEntry = async (entry) => {
    if (entry && !pastEntry && !(await guardLeaving())) return;
    await history.selectEntry(entry);
  };

  // A document opened with no tab named lands on the one the app says it
  // should, once, on the first live load: not on a past state, and not after
  // the reader has picked a tab. Replace, not push: the reader did not ask for
  // this tab, so Back leaves the document instead of undoing the landing.
  // A tab picked while the document loads names itself in the address, and
  // the landing leaves it alone.
  const landedRef = useRef(!query || searchParams.has('tab'));
  const picked = searchParams.has('tab');
  useEffect(() => {
    if (picked) landedRef.current = true;
    if (!doc || history.asOf || landedRef.current) return;
    landedRef.current = true;
    const to = query.landing?.(doc);
    if (to && to !== queryTab) setQueryTab(to, { replace: true });
  }, [doc, history.asOf, picked, query, queryTab, setQueryTab]);

  // The check on open, where the app has the shell run it. It writes
  // nothing, so nothing waits on it.
  useValidateOnOpen({
    doc: app.validateOnOpen ? doc : null,
    asOf: history.asOf,
    canWrite: canEditProject(project, user),
  });

  // The integrity notice the check raises never expires, because what it
  // found is a standing fact. It is about one DOCUMENT, not about
  // one tab: it belongs to the shell, which survives a tab switch. Leaving the
  // document, or opening another one, takes it with us.
  useEffect(() => () => dismissIntegrityFindings(), [documentId]);

  // A save in flight lives only in this browser tab, so a reload or a tab
  // close asks first while one is still on its way, here and after the reader
  // has left for another screen (the write queue outlives this one).
  useSavingGuard(doc);
  // Once the reader has left, a refetch after a refused edit has nothing left
  // to put right, and stops (DocumentModel.hold).
  useEffect(() => doc?.hold(), [doc]);
  // A comment post, edit or delete on its way asks the same way.
  useSavingGuard(comments);

  // The tab first, as in every app, then the document and its project.
  const tabLabel = app.tabs.list.find((t) => t.value === tab)?.label;
  useDocumentTitle(tabLabel, shown?.raw?.name, project?.name);

  // Every document tab is full width in `Layout`, so the breadcrumb and the
  // tab row stand in one place whichever tab is open. The wide tabs are
  // full-bleed and supply their own padding; the others are held to a readable
  // width under the tabs.
  const wide = (app.tabs.wide ?? [app.tabs.editor]).includes(tab);
  // The editors slow down with the document's length.
  const words = app.wordCount?.(doc);
  // "Ask" under a sentence is only worth drawing where there is an assistant to
  // ask, and only on the tab whose content it points into. The PANEL itself is
  // the shell's and is open on every tab.
  const onEditor = tab === app.tabs.editor;
  const assistantAvailable = useAssistantAvailable(client, projectId, app.assistantApp);
  // A citation into THIS document scrolls the editor instead of opening a
  // second browser tab: the URL params the annotation editor already watches,
  // so setting them reuses the scroll and the flash.
  // Bumped on every ask, so clicking the SAME citation twice scrolls again:
  // the editor only reacts to its params changing, and a repeat does not
  // change them.
  const [focusNonce, setFocusNonce] = useState(0);
  const focusByParams = useCallback(
    ({ documentId: cited, focus }) => {
      // Only while the editor is actually on screen. Claiming a citation on
      // another tab would swallow the link and scroll nothing: the panel is
      // open on every tab, and only one of them watches the params.
      const params = cited === documentId && onEditor ? app.focusParams?.(focus) : null;
      if (!params) return false;
      setFocusNonce((k) => k + 1);
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          for (const [key, value] of Object.entries(params)) {
            if (value == null) next.delete(key);
            else next.set(key, value);
          }
          return next;
        },
        { replace: true },
      );
      return true;
    },
    [app, documentId, onEditor, setSearchParams],
  );
  const useFocusHere = app.useFocusHere ?? noFocus;
  const focusHere = useFocusHere({ documentId, onEditor }) ?? focusByParams;
  // What the shell's assistant panel is about while this screen is open. The
  // document is the subject on EVERY tab: it is what the reader is looking at
  // either way.
  useAssistantSubject({
    projectId,
    projectName: project?.name,
    kind: 'document',
    id: documentId,
    name: doc?.raw?.name,
    canWrite: canEditProject(project, user) && !pastEntry,
    // The document's copy of the project, which it reads again while open, so
    // a change of whose work is reviewed reaches the dock.
    contributor: !!project && !!user && isReviewed(project, user.id, { isAdmin: !!user.isAdmin }),
    onApplied: reload,
    onFocusHere: focusHere,
    // What `@` offers in the composer: this document's sentences, by the same
    // reference Ask writes. The hint is what the sentence SAYS, because that is
    // what a reader remembers about it rather than its number.
    mentions: () => {
      const items = (doc?.sentences || []).map((sentence, i) => {
        const ref = app.sentenceRef(sentence, i);
        const hint = app.sentenceHint ? app.sentenceHint(sentence, doc) : sentence.text;
        return { value: ref, label: ref, hint };
      });
      return items.length ? [{ group: 'Sentences', items }] : [];
    },
  });
  // "Ask" under a sentence hands the panel a {ref, label} and opens it. It goes
  // down the outlet to the editor; the panel picks it up in the shell.
  const askAssistant = useAskAssistant();

  const context = {
    projectId,
    documentId,
    client,
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
    acquireWriteLock: writeLock.acquire,
    setChromeBusy,
    assistantAvailable,
    askAssistant,
    focusNonce,
    // How a tab sends the reader to another tab.
    goToTab: setQueryTab,
  };

  return (
    <div className="pt-4">
      <DocumentHistoryPanel
        history={{ ...history, selectEntry }}
        client={client}
        documentId={documentId}
        raw={doc?.raw}
        // A restore rewrites the whole document, which is exactly what a
        // running service is doing.
        canRestore={canManageProject(project, user) && !writeLock.held}
        roleWords={app.roleWords}
        layerWords={app.layerWords}
      />

      {/* The way into History at the window's left edge, the twin of the
          assistant's on the right (EdgeRail). The button in the tab row is
          the named way in. */}
      {!history.drawerOpen && doc && !chromeBusy && (
        <EdgeRail
          side="left"
          label="Open history"
          title="Open history"
          onClick={history.openHistory}
          className="z-30"
        >
          <History className="h-4 w-4 text-white opacity-0 transition-opacity group-hover:opacity-100" />
        </EdgeRail>
      )}

      {/* Chrome: rendered unconditionally, including while the document loads.
          That is what stops the tab switch from blanking the page. Straight
          in the page box, with no wrapper of its own: the pinned tab row stays
          pinned only as far down as its parent box reaches. Each part takes
          the page's inset itself, since the box runs to the window's edge. */}
      <DocumentTabStrip
        projectId={projectId}
        project={project}
        document={shown?.raw}
        failed={!loading && !doc}
        tabs={app.tabs.list.map((t) => ({
          ...t,
          to: tabHref(t.value),
          count: t.value === 'comments' ? (comments?.count ?? 0) : 0,
        }))}
        active={tab}
        disabled={chromeBusy}
        status={doc && app.saveStatus !== false ? <SaveStatus doc={doc} /> : null}
        sticky
        inset={DOC_GUTTER}
        actions={
          // Not a tab: history is a drawer, and it keeps whatever tab you are
          // on.
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
        <div className={wide ? DOC_GUTTER : cn('max-w-[1320px]', DOC_GUTTER)}>
          <HistoricalBanner entry={pastEntry} loading={history.loadingSnapshot} className="mb-4" />
          {writeLock.held && <RunBanner {...writeLock.held} />}
        </div>
      )}

      {app.tabs.long?.includes(tab) && isLongDocument(words) && (
        <div className={wide ? DOC_GUTTER : cn('max-w-[1320px]', DOC_GUTTER)}>
          <LongDocumentNotice words={words} className="mb-4" />
        </div>
      )}

      {loading && <Loading className={DOC_GUTTER} />}

      {!loading && (loadError || !doc || !project) && (
        <div className={wide ? DOC_GUTTER : cn('max-w-[1320px]', DOC_GUTTER)}>
          <Notice tone="error" icon={null} role="alert">
            {loadError || 'Document or project not found'}
          </Notice>
        </div>
      )}

      {/* The PAGE scrolls, whether or not the assistant is open. The panel is
          fixed in the shell and takes a gutter on the right, so this layout
          does not change when it opens. */}
      {!loading && !loadError && doc && project && (
        // Always this div, its class alone changing with the tab: a
        // wrapper that came and went would remount the tab under it.
        <div className={wide ? undefined : cn('max-w-[1320px] pb-8', DOC_GUTTER)}>
          {pastEntry && !onPastTab ? (
            <p className="pt-2 text-sm text-muted-foreground">Not shown at a past state.</p>
          ) : query ? (
            app.renderTab(tab, context)
          ) : (
            <Outlet context={context} />
          )}
        </div>
      )}
    </div>
  );
};
