import { useState, useEffect, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Button } from '@ui/components/ui/button';
import { Textarea } from '@ui/components/ui/textarea';
import { cpSlice } from '@larc-iu/plaid-client';
import { useEditLog } from '@ui/hooks/useEditLog.js';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { plural } from '@ui/lib/plural.js';
import { containsToken } from '../../utils/udLayerUtils.js';
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
      // A cleanup before the outline faded (StrictMode's second run on mount)
      // leaves the id unanswered, so the next run outlines it again with a
      // timer of its own. Kept answered, the outline would stay for good.
      if (flashTimer) {
        clearTimeout(flashTimer);
        scrolledForRef.current = null;
      }
    };
  }, [sentParam]);

  useDocumentTitle('Text Editor', doc?.name, project?.name);

  const serverText = doc.layerInfo.textLayer?.text?.body || '';
  const serverDigest = doc.layerInfo.textLayer?.text?.digest ?? null;

  // What was typed in the box, as edits over the stored body they were typed
  // on (plaid-ui lib/editLog.js). The box shows the body the log makes, and
  // its base is what a save sends the edits against (ConlluDocument.saveText).
  const editLog = useEditLog();
  const { log } = editLog;
  const textContent = log.body;
  // What a save on its way has sent, split off the log (`send`). The edits
  // typed meanwhile are logged over the body it makes.
  const [sending, setSending] = useState(null);

  // Mirror the server's text into the textarea whenever it changes underneath
  // us: the initial load, a save's answer, or a service that rewrote the
  // body. Keyed on the body itself rather than on the doc instance, so the
  // many emits from ordinary token edits don't stomp on what the user is
  // typing. A draft is kept across a new body: its edits are moved onto it,
  // and when they touch a passage the new body changed too, the box and its
  // base stay as they were. While a save is on its way the save settles the
  // log itself (handleSaveText). Done while rendering, so the box and the
  // tokens change in one render.
  const [mirrored, setMirrored] = useState({ documentId: null, body: null });
  if (mirrored.documentId !== documentId || (serverText && mirrored.body !== serverText)) {
    setMirrored({ documentId, body: serverText });
    const sameDocument = mirrored.documentId === documentId;
    if (!sameDocument || !sending) {
      if (sameDocument && log.body !== log.base) editLog.rebase(serverText, serverDigest);
      else editLog.reset(serverText, serverDigest);
    }
  }

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
    const sent = editLog.send();
    setSending(sent);
    let stored = null;
    const ok = await doc.saveText(sent, {
      onStored: (body, digest) => {
        stored = { body, digest };
      },
    });
    setSending(null);
    const text = doc.layerInfo.textLayer?.text;
    if (!ok || stored == null) {
      // Not saved: the sent edits go back in the box's log, in front of what
      // was typed since, and onto the stored body if it has moved on.
      const back = editLog.unsend(sent);
      const now = text?.body ?? '';
      if (now && now !== back.base) editLog.rebase(now, text?.digest ?? null);
      return;
    }
    setLastSaved(new Date());
    // What was stored can hold another user's changes merged in. Text typed
    // while the save was on its way is kept, on top of it.
    const now = text?.body === stored.body ? text : stored;
    editLog.rebase(now.body, now.digest ?? null);
  };

  // The box's text and its base go back to what is stored.
  const handleDiscard = () => {
    editLog.reset(serverText, serverDigest);
    setLastSaved(null);
  };

  const handleTextChange = (e) => {
    editLog.onChange(e);
    if (lastSaved) setLastSaved(null);
  };

  const handleClearTokens = async () => {
    if (!doc) return;
    const ok = await confirm({
      title: 'Clear all tokens?',
      description: 'This cannot be undone.',
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

  // What goes with a token's words, as the question before it goes names it.
  // Null when nothing does. Deleting the token also loses its words' forms
  // (a multiword token's split, a respelled word).
  const lossOf = (word, { withForms = false } = {}) => {
    const loss = doc.annotationLossForWord(word);
    const annotations = loss.annotations + (withForms ? loss.forms : 0);
    const { relations } = loss;
    const parts = [
      annotations > 0 && `${annotations} ${plural(annotations, 'annotation')}`,
      relations > 0 && `${relations} ${plural(relations, 'relation')}`,
    ].filter(Boolean);
    if (parts.length === 0) return null;
    const surface = cpSlice(serverText, word.begin, word.end);
    return `Deletes ${parts.join(' and ')} on “${surface}”.`;
  };

  // A token whose words carry annotations asks before it goes. The server
  // takes its words with everything on them.
  const handleWordDelete = async (wordId) => {
    if (!doc) return;
    const word = doc.layerInfo.wordTokenLayer?.tokens?.find((t) => t.id === wordId);
    const loss = word ? lossOf(word, { withForms: true }) : null;
    if (loss) {
      const ok = await confirm({
        title: 'Delete token?',
        description: loss,
        confirmLabel: 'Delete',
        destructive: true,
      });
      if (!ok) return;
    }
    doc.deleteWord(wordId);
  };
  const handleSentenceBoundaryToggle = (charPos) => doc?.toggleSentenceBoundary(charPos);
  // As many words as before respells them and keeps what is on them. Another
  // count replaces them, and asks first when that deletes annotations.
  const handleSetWordMorphemes = async (word, forms) => {
    if (!doc) return;
    const count = (doc.layerInfo.morphemeTokenLayer?.tokens || []).filter((m) =>
      containsToken(word, m),
    ).length;
    const loss = count === forms.length ? null : lossOf(word);
    if (loss) {
      const ok = await confirm({
        title: 'Change words?',
        description: loss,
        confirmLabel: 'Change',
        destructive: true,
      });
      if (!ok) return;
    }
    await doc.setWordMorphemes(word, forms);
  };

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
    canEditProject(project, user) && (sending || textContent !== log.base)
      ? 'The text you have typed'
      : null,
  );
  const hasTokens = sentenceTokens.length > 0 || wordTokens.length > 0 || morphemeTokens.length > 0;

  // The tokens are always at their places in the stored body, which comes in
  // the same render as they do. It is what the box's text is measured against
  // for "Unsaved changes", and what the token view moves them from.
  const originalTokenizedText = hasTokens ? serverText : '';
  const isTextDirty = Boolean(originalTokenizedText) && textContent !== originalTokenizedText;
  // Typed over a body that has changed since, and not put onto it: the two
  // changed the same passage.
  const behind =
    !sending && textContent !== log.base && Boolean(serverText) && log.base !== serverText;
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
            {...editLog.handlers}
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
                disabled={saving || !textContent.trim() || textContent === log.base}
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
