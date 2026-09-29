import { useState, useEffect, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Button } from '@ui/components/ui/button';
import { Textarea } from '@ui/components/ui/textarea';
import { cpSlice } from '@larc-iu/plaid-client';
import { mergeText } from '@ui/lib/textMerge.js';
import { useAuth } from '../../contexts/AuthContext.jsx';
import {
  hasForeignSubstrateParticipants,
  foreignAnnotationLossForWord,
} from '../../utils/udLayerUtils.js';
import { useConfirm } from '@ui/components/shared/ConfirmProvider';
import { Notice } from '@ui/components/shared/Notice.jsx';
import { DELETE_BUTTON_CLASS } from '@ui/lib/destructive.js';
import { canEditProject } from '@ui/domain/permissions.js';
import { NOT_SET_UP } from '@ui/domain/setupGuard.js';
import { TokenVisualizer } from './TokenVisualizer.jsx';
import { useDocumentEditor } from '@ui/hooks/useDocumentEditor.js';
import { ParseDialog } from './services/ParseDialog.jsx';
import { TokenizeDialog } from './services/TokenizeDialog.jsx';
import { useDocumentTitle } from '@ui/hooks/useDocumentTitle.js';
import { useUnsavedDraft } from '@ui/hooks/useUnsavedDraft.js';
import { sentenceNumberOf } from './hooks/useSentenceDeepLink.js';

export const TextEditor = () => {
  // Project, document, the breadcrumbs/tab strip and the version-counter
  // subscription all come from DocumentEditorShell, which guarantees both the
  // project and the document are loaded before this renders.
  const { projectId, documentId, doc, project, services, writeLockHeld } = useDocumentEditor();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const sentParam = searchParams.get('sent');
  const [flashSentId, setFlashSentId] = useState(null);
  const scrolledForRef = useRef(null);
  const [textContent, setTextContent] = useState('');
  const [lastSaved, setLastSaved] = useState(null);
  const { getClient, user } = useAuth();
  const confirm = useConfirm();
  // The box grows with the text rather than scrolling, the way it did before:
  // a treebank's source text is read as a whole, and an inner scrollbar inside
  // a page that also scrolls is two places to lose your position.
  const textareaRef = useRef(null);

  // Alt+click a token: hand over to Annotate at that sentence, using the same
  // `?sent=` the Search results already land on.
  const openInAnnotate = (sentenceTokenId) =>
    navigate(`/projects/${projectId}/documents/${documentId}/annotate?sent=${sentenceTokenId}`);

  // The other direction: arriving from Annotate with `?sent=`, scroll that
  // sentence's block into view and flash it. Once per id, so a later render
  // does not yank the page back to it.
  //
  // The block is not there on the first pass: this tab loads the text into
  // local state before the visualizer can group anything into sentences, and
  // that is not a change any dependency here can watch. So wait for it, on a
  // bounded loop, and give up quietly if the document has no tokens at all.
  useEffect(() => {
    if (!sentParam || scrolledForRef.current === sentParam) return;
    let frame = null;
    let flashTimer = null;
    const deadline = Date.now() + 3000;
    const attempt = () => {
      frame = null;
      // An id, else a sentence number counted from 1.
      const blocks = [...document.querySelectorAll('[data-sentence-block]')];
      const number = sentenceNumberOf(sentParam);
      const el =
        blocks.find((b) => b.getAttribute('data-sentence-block') === String(sentParam)) ||
        (number != null ? blocks[number - 1] : null);
      if (el) {
        scrolledForRef.current = sentParam;
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        setFlashSentId(el.getAttribute('data-sentence-block'));
        flashTimer = setTimeout(() => setFlashSentId(null), 2000);
        return;
      }
      if (Date.now() > deadline) return;
      frame = requestAnimationFrame(attempt);
    };
    attempt();
    return () => {
      if (frame) cancelAnimationFrame(frame);
      if (flashTimer) clearTimeout(flashTimer);
    };
  }, [sentParam]);

  useDocumentTitle('Text Editor', doc?.name, project?.name);

  const serverText = doc.layerInfo.textLayer?.text?.body || '';

  // Mirror the server's text into the textarea whenever it changes underneath
  // us: the initial load, a save's refetch, or a service that rewrote the
  // body. Keyed on the body itself rather than on the doc instance, so the
  // many emits from ordinary token edits don't stomp on what the user is
  // typing. `seeded` is the stored body the box's text was typed over (the
  // base a save merges from, see ConlluDocument.saveText). A draft is kept
  // across a new body: its changes are put onto it, and when they touch a
  // passage the new body changed too, the box and its base stay as they were.
  // Done while rendering, so the box and the tokens change in one render.
  const [seeded, setSeeded] = useState('');
  const [mirrored, setMirrored] = useState({ documentId: null, body: null });
  if (serverText && (mirrored.documentId !== documentId || mirrored.body !== serverText)) {
    setMirrored({ documentId, body: serverText });
    const draft = mirrored.documentId === documentId && textContent !== seeded;
    const merged = draft ? mergeText(seeded, textContent, serverText) : { text: serverText };
    if (!merged.conflict) {
      setTextContent(merged.text);
      setSeeded(serverText);
    }
  }
  // The box's text as of the last render, for a save that resolves later.
  const textNow = useRef('');
  textNow.current = textContent;

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [textContent]);

  // Every write from here carries the version this tab read, so a save,
  // a Tokenize or a sentence split made on a copy another user has since
  // changed is refused (409) rather than laid over their change.
  useEffect(() => {
    const client = getClient();
    if (!client) return undefined;
    client.enterStrictMode(documentId);
    return () => client.exitStrictMode();
  }, [documentId, getClient]);

  // --- thin wrappers around doc methods, kept for the bits that need to
  // poke TextEditor-local state (originalTokenizedText, lastSaved, etc.). ---

  const handleSaveText = async () => {
    if (!doc) return;
    if (!textContent.trim() || doc.isSaving) return;
    const sent = textContent;
    let stored = null;
    const ok = await doc.saveText(sent, {
      base: seeded,
      onStored: (body) => {
        stored = body;
      },
    });
    if (!ok || stored == null) return;
    setLastSaved(new Date());
    // What was stored can hold another user's changes merged in. Text typed
    // while the save was on its way is kept, on top of it.
    const now = textNow.current;
    const rebased = now === sent ? { text: stored } : mergeText(sent, now, stored);
    if (rebased.conflict) return;
    setTextContent(rebased.text);
    setSeeded(stored);
  };

  // The box's text and its base go back to what is stored.
  const handleDiscard = () => {
    setTextContent(serverText);
    setSeeded(serverText);
    setLastSaved(null);
  };

  const handleTextChange = (e) => {
    setTextContent(e.target.value);
    if (lastSaved) setLastSaved(null);
  };

  const handleClearTokens = async () => {
    if (!doc) return;
    // Tokens may belong to a substrate shared with another app (e.g. IGT). The
    // clear cascades into that app's tokens/annotations, so warn explicitly.
    const shared = hasForeignSubstrateParticipants(doc.layerInfo);
    const ok = await confirm({
      title: 'Clear all tokens?',
      description: shared
        ? 'These tokens are shared with another app on this project, such as interlinear ' +
          "glossing. Clearing them here also deletes that app's annotations on this " +
          'document. This cannot be undone.'
        : 'This cannot be undone.',
      confirmLabel: 'Clear',
      destructive: true,
    });
    if (!ok) return;
    await doc.clearTokens();
  };

  const handleWordCreate = async (begin, end) => {
    if (!doc) return;
    await doc.createWord(begin, end, textContent);
  };

  // Deleting a word cascades into layers nested under the shared word layer —
  // including other apps' (e.g. IGT's morphemes with their glosses and vocab
  // links), none of which are visible here. Confirm ONLY when such foreign
  // material would actually die; UD-only projects and unannotated words keep
  // the instant delete. (Sentence merges don't need this: the server reparents
  // the dying token's spans to the survivor. Word RESIZING was removed
  // outright — a resize keeps token identity while changing what it means, so
  // annotations silently drift onto different text; boundary fixes are now
  // delete + re-create, which routes through this warning.)
  const handleWordDelete = async (wordId) => {
    if (!doc) return;
    const info = doc.layerInfo;
    const word = info.wordTokenLayer?.tokens?.find((t) => t.id === wordId);
    const { spans, links } = foreignAnnotationLossForWord(info, word);
    if (spans + links === 0) return doc.deleteWord(wordId);
    const surface = word ? cpSlice(textContent, word.begin, word.end) : 'this token';
    const losses = [
      spans > 0 && `${spans} annotation${spans === 1 ? '' : 's'}`,
      links > 0 && `${links} vocabulary link${links === 1 ? '' : 's'}`,
    ]
      .filter(Boolean)
      .join(' and ');
    const ok = await confirm({
      title: 'Delete token?',
      description:
        `Deleting “${surface}” also deletes ${losses} from another app on this ` +
        'project, such as interlinear glossing, which are not visible in this editor. ' +
        'This cannot be undone.',
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (ok) doc.deleteWord(wordId);
  };
  const handleSentenceBoundaryToggle = (charPos) => doc?.toggleSentenceBoundary(charPos);
  const handleSetWordMorphemes = (word, forms) => doc?.setWordMorphemes(word, forms);

  const layerInfo = doc.layerInfo;
  const sentenceTokens = layerInfo.sentenceTokenLayer?.tokens || [];
  const wordTokens = layerInfo.wordTokenLayer?.tokens || [];
  const morphemeTokens = layerInfo.morphemeTokenLayer?.tokens || [];

  // morpheme id -> Form span value (overrides text substring for display).
  const morphemeForms = new Map();
  (layerInfo.formLayer?.spans || []).forEach((span) => {
    const tokenId = Array.isArray(span.tokens) && span.tokens.length > 0 ? span.tokens[0] : null;
    if (tokenId != null && span.value != null) morphemeForms.set(tokenId, span.value);
  });

  // Typed and not yet on the server: every way out of the tab asks first. The
  // measure is the saved body, not the tokenized one, so text typed into a
  // document that has no tokens yet counts too. It is the body as last copied
  // into the box rather than `serverText` itself: for the one render between a
  // load and that copy the two differ, and a draft that comes and goes in one
  // tick adds and takes out a history entry under the router.
  useUnsavedDraft(
    canEditProject(project, user) && textContent !== seeded ? 'The text you have typed' : null,
  );
  const hasTokens = sentenceTokens.length > 0 || wordTokens.length > 0 || morphemeTokens.length > 0;

  // The tokens are always at their places in the stored body, which comes in
  // the same render as they do. It is what the box's text is measured against
  // for "Unsaved changes", and what the token view moves them from.
  const originalTokenizedText = hasTokens ? serverText : '';
  const isTextDirty = Boolean(originalTokenizedText) && textContent !== originalTokenizedText;
  // Typed over a body that has changed since, and not put onto it: the two
  // changed the same passage.
  const behind = textContent !== seeded && Boolean(serverText) && seeded !== serverText;
  const hasText = Boolean(layerInfo.textLayer?.text?.body);
  const saving = doc.isSaving;

  // Viewer-access users get the text editor read-only: the textarea is locked,
  // the save/tokenize/clear actions are hidden, and the visualizer's edit
  // handlers are withheld (it already null-guards every interaction). A service
  // run writing to this document folds in the same way: it ends in a reload
  // that would discard anything typed underneath it.
  const canEdit = canEditProject(project, user);
  const readOnly = !canEdit || !!writeLockHeld;

  // Project-level misconfig: the three token layers exist but their
  // overlap-mode / parent chain doesn't match the UD layout. Runtime
  // validation (not legacy detection) — applies regardless of how the data
  // got there.
  const layersMisconfigured = Boolean(
    layerInfo.isConfigured &&
      layerInfo.sentenceTokenLayer &&
      layerInfo.wordTokenLayer &&
      layerInfo.morphemeTokenLayer &&
      (layerInfo.sentenceTokenLayer.overlapMode !== 'partitioning' ||
        layerInfo.wordTokenLayer.overlapMode !== 'non-overlapping' ||
        layerInfo.wordTokenLayer.parentTokenLayer !== layerInfo.sentenceTokenLayer.id ||
        layerInfo.morphemeTokenLayer.parentTokenLayer !== layerInfo.wordTokenLayer.id),
  );

  const setupIncomplete = !layerInfo.isConfigured;

  return (
    <div>
      {!canEdit && (
        <Notice className="mb-3">Read-only. You have reader access to this project.</Notice>
      )}

      {setupIncomplete && (
        <Notice tone="warning" className="mb-3">
          {NOT_SET_UP}
        </Notice>
      )}

      {behind && !readOnly && (
        <Notice tone="warning" className="mb-3" role="alert">
          Changed elsewhere in the same passage.{' '}
          <Button size="sm" variant="outline" className="ms-2 h-7" onClick={handleDiscard}>
            Discard changes
          </Button>
        </Notice>
      )}

      {layersMisconfigured && (
        <Notice tone="warning" className="mb-3">
          This project is set up incompletely. Tokens can still be made. Recreate the project to fix
          it.
        </Notice>
      )}

      {/* `min-w-0` on each column: a grid column is otherwise as wide as its
          widest row of buttons, and on a phone that pushed the page sideways. */}
      <div className="grid gap-8 lg:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-4">
          <h4 className="text-base font-semibold">Text</h4>
          <Textarea
            ref={textareaRef}
            value={textContent}
            spellCheck={false}
            onChange={handleTextChange}
            readOnly={readOnly}
            placeholder="Type or paste the text. One sentence per line."
            rows={12}
            className="resize-none overflow-hidden leading-relaxed"
          />

          <div className="flex flex-wrap items-center gap-3">
            {!readOnly && (
              <Button
                onClick={handleSaveText}
                disabled={saving || !textContent.trim() || textContent === seeded}
              >
                Save
              </Button>
            )}

            {canEdit && (
              <TokenizeDialog
                tokenize={services.tokenize}
                text={textContent}
                writeLockHeld={writeLockHeld}
                blockedHint={
                  !textContent.trim()
                    ? 'There is no text to tokenize.'
                    : isTextDirty
                      ? 'Save the text first.'
                      : hasTokens
                        ? 'Clear tokens before re-tokenizing.'
                        : null
                }
              />
            )}

            {canEdit && hasText && (
              <ParseDialog
                parse={services.parse}
                isDiscovering={services.isDiscovering}
                writeLockHeld={writeLockHeld}
                blockedHint={hasTokens ? null : 'Tokenize the text first.'}
              />
            )}

            {!readOnly && (
              <Button
                variant="outline"
                className={DELETE_BUTTON_CLASS}
                onClick={handleClearTokens}
                disabled={saving || !hasTokens}
              >
                Clear tokens
              </Button>
            )}

            <span className="ms-auto whitespace-nowrap text-sm font-medium text-muted-foreground">
              {wordTokens.length} token{wordTokens.length !== 1 ? 's' : ''}, {sentenceTokens.length}{' '}
              sentence{sentenceTokens.length !== 1 ? 's' : ''}
            </span>
          </div>

          <p className="text-sm">
            {/* Offline, the shell's save status says so, over every tab. */}
            {saving && !doc.isOffline && <span className="italic text-blue-600">Saving…</span>}
            {!saving && lastSaved && (
              <span className="text-success">Saved: {lastSaved.toLocaleTimeString()}</span>
            )}
            {!saving && !lastSaved && textContent && isTextDirty && (
              <span className="italic text-warning-foreground">Unsaved changes</span>
            )}
          </p>
        </div>

        <div className="min-w-0 rounded-md border bg-muted/40 p-4">
          <h4 className="mb-4 text-base font-semibold">Tokens</h4>
          <TokenVisualizer
            text={textContent}
            originalText={originalTokenizedText}
            sentenceTokens={sentenceTokens}
            wordTokens={wordTokens}
            morphemeTokens={morphemeTokens}
            morphemeForms={morphemeForms}
            onWordCreate={readOnly ? null : handleWordCreate}
            onWordDelete={readOnly ? null : handleWordDelete}
            onSentenceToggle={readOnly ? null : handleSentenceBoundaryToggle}
            onSetWordMorphemes={readOnly ? null : handleSetWordMorphemes}
            onOpenInAnnotate={openInAnnotate}
            flashSentenceId={flashSentId}
            textDirection={doc.textDirection ?? 'ltr'}
            setError={(msg) => doc.setError(msg)}
          />
        </div>
      </div>
    </div>
  );
};
