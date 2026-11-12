import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useConfirm } from '@ui/components/shared/ConfirmProvider';
import { heldBy } from '@ui/components/services/runHeld.js';
import { IgtEditor } from './island/IgtEditor.js';
import { AutoAnalyzeDialog } from './AutoAnalyzeDialog.jsx';
import { useDocumentCtx } from '../contexts/DocumentContext.jsx';
import { useAuth } from '../../../contexts/AuthContext.jsx';
import { canEditVocabularyEntries } from '@ui/domain/permissions.js';
import { useVocabularyHomes, vocabularyHome } from '../../../hooks/useVocabularyHomes.js';
import { useAskAssistant } from '@ui/components/assistant/subject.js';
import { onSentenceFocus } from '../hooks/focusHandoff.js';

// Thin React shell around the vanilla IgtEditor island. Consumes the single
// shared IgtDocument from DocumentContext (the same instance the other tabs use)
// instead of loading its own — this is what kills the old double-fetch. The
// island owns all rendering + edits; React just manages the mount lifecycle.
//
// Time-travel: DocumentDetail reloads the shared doc when `asOf` changes, so the
// doc identity changes and the mount effect below re-mounts the island onto the
// new historical snapshot automatically. readOnly is synced without remounting.
const PAGE_PARAM = 'page';
const pageFromParam = (raw) => {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 ? n - 1 : 0;
};

export const AnalyzeIsland = () => {
  const {
    doc,
    client,
    readOnly,
    comments,
    canWrite,
    canManage,
    assistantOnline,
    goToTab,
    writeLock,
  } = useDocumentCtx();
  const hostRef = useRef(null);
  const editorRef = useRef(null);
  // The island's Auto-analyze toolbar button opens this React-side modal
  // (service discovery + param forms are React machinery).
  const [autoAnalyzeOpen, setAutoAnalyzeOpen] = useState(false);

  // What the island asks of the page, read through refs because the island is
  // built once. goToTab changes with the query string it closes over, and a
  // stale one would write the tab onto an outdated URL. Ask opens the shell's
  // assistant panel on what was pointed at, the channel a React screen uses.
  const goToTabRef = useRef(goToTab);
  goToTabRef.current = goToTab;
  const ask = useAskAssistant();
  const askRef = useRef(ask);
  askRef.current = ask;

  // The page of sentences lives in the URL as `?page=`, 1-based with page 1
  // unwritten, as every paged list does. Turning a page is a push, so Back
  // undoes it.
  const [params, setParams] = useSearchParams();
  const urlPage = pageFromParam(params.get(PAGE_PARAM));
  const urlPageRef = useRef(urlPage);
  urlPageRef.current = urlPage;
  const setParamsRef = useRef(setParams);
  setParamsRef.current = setParams;
  useEffect(() => {
    editorRef.current?.setPage(urlPage);
  }, [urlPage]);

  // A citation in the panel into this document, while the grid is up.
  useEffect(() => onSentenceFocus((req) => editorRef.current?.focusSentence(req)), []);

  // Adding an entry and changing a linked entry's type are for a writer of
  // the vocabulary's project, wherever they stand: for a vocabulary this
  // project borrows, its home is read, and someone who cannot read it holds
  // no role there. Linking a word to an entry needs only write access to the
  // document. The island asks through a ref and is told when the homes land.
  const { user } = useAuth();
  const homes = useVocabularyHomes(client ?? doc?.client, doc?.project);
  const homesRef = useRef(homes);
  homesRef.current = homes;
  const canEditEntries = (vocab) =>
    canEditVocabularyEntries(vocab, vocabularyHome(vocab, doc?.project, homesRef.current), user);
  useEffect(() => {
    editorRef.current?.refreshEntryRights();
  }, [homes]);

  // The island is built once, so the confirm it holds reads through a ref and
  // its identity never has to change. Same dialog the entry panel asks with:
  // two renderings of a thread should not ask differently.
  const confirm = useConfirm();
  const confirmRef = useRef(confirm);
  confirmRef.current = confirm;

  useEffect(() => {
    if (!doc || !hostRef.current) return undefined;
    editorRef.current = new IgtEditor(hostRef.current, doc, {
      readOnly,
      // Not `!readOnly`: an Auto-analyze run takes the document read-only for
      // as long as it writes, and its button carries the run's progress.
      canAutoAnalyze: canWrite,
      canEditEntries,
      // The SAME store the Comments tab renders from, so a comment posted on a
      // word is already there when you switch tabs.
      comments,
      canComment: canWrite,
      canDeleteAnyComment: canManage,
      confirmDeleteComment: (comment) =>
        confirmRef.current({
          title:
            comment.authorId === comments?.currentUserId
              ? 'Delete your comment?'
              : `Delete ${comments?.authorName(comment.authorId)}'s comment?`,
          description: 'This cannot be undone.',
          confirmLabel: 'Delete',
          destructive: true,
        }),
      assistantOnline,
      onNavigateTab: (tab) => {
        if (tab) goToTabRef.current?.(tab);
      },
      onOpenAutoAnalyze: () => setAutoAnalyzeOpen(true),
      onAskAssistant: (subject) => {
        if (subject) askRef.current(subject);
      },
      page: urlPageRef.current,
      onPageChange: (next, { replace }) =>
        setParamsRef.current(
          (prev) => {
            const out = new URLSearchParams(prev);
            if (next <= 0) out.delete(PAGE_PARAM);
            else out.set(PAGE_PARAM, String(next + 1));
            return out;
          },
          { replace },
        ),
    });
    return () => {
      if (editorRef.current) {
        editorRef.current.destroy();
        editorRef.current = null;
      }
    };
    // readOnly intentionally excluded — synced via the effect below without
    // tearing down the island. doc identity changes on (re)load / time-travel.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, comments]);

  useEffect(() => {
    if (editorRef.current) editorRef.current.setReadOnly(readOnly);
  }, [readOnly]);

  useEffect(() => {
    editorRef.current?.setCanAutoAnalyze(canWrite);
  }, [canWrite]);

  // While an Auto-analyze run holds the document, whichever page started it,
  // its button turns and is disabled: the banner shows the run and has Stop.
  // Told again when the island is built anew (a new doc, a tab come back to).
  const autoAnalyzing = heldBy(writeLock, 'Auto-analyze');
  useEffect(() => {
    editorRef.current?.setAutoAnalyzeRunning(autoAnalyzing);
  }, [autoAnalyzing, doc, comments]);

  useEffect(() => {
    editorRef.current?.setAssistantOnline(assistantOnline);
  }, [assistantOnline]);

  useEffect(() => {
    editorRef.current?.setCommentPermissions({
      canComment: canWrite,
      canDeleteAnyComment: canManage,
    });
  }, [canWrite, canManage]);

  return (
    <div className="igt-analyze-mount">
      {!doc && (
        <div style={{ padding: 24, color: 'hsl(var(--muted-foreground))' }}>
          Loading interlinear editor…
        </div>
      )}
      <div ref={hostRef} className="igt-island" style={{ display: doc ? 'block' : 'none' }} />
      {doc && (
        <AutoAnalyzeDialog open={autoAnalyzeOpen} onOpenChange={setAutoAnalyzeOpen} doc={doc} />
      )}
    </div>
  );
};
