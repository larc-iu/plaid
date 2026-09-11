import { useState, useEffect, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Button } from '@ui/components/ui/button';
import { Textarea } from '@ui/components/ui/textarea';
import { cpSlice } from '@larc-iu/plaid-client';
import { useAuth } from '../../contexts/AuthContext.jsx';
import {
  missingUdLayerLabels,
  hasForeignSubstrateParticipants,
  foreignAnnotationLossForWord,
} from '../../utils/udLayerUtils.js';
import { useConfirm } from '@ui/components/shared/ConfirmProvider';
import { canEditProject } from '../../utils/permissions.js';
import { TokenVisualizer } from './TokenVisualizer.jsx';
import { useDocumentEditor } from './useDocumentEditor.js';
import { ParseDialog } from './services/ParseDialog.jsx';
import { TokenizeDialog } from './services/TokenizeDialog.jsx';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';

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
  const [originalTokenizedText, setOriginalTokenizedText] = useState('');
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
      const el = document.querySelector(`[data-sentence-block="${CSS.escape(String(sentParam))}"]`);
      if (el) {
        scrolledForRef.current = sentParam;
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        setFlashSentId(String(sentParam));
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
  // us: the initial load, or a service that rewrote the body. Keyed on the body
  // itself rather than on the doc instance, so the many emits from ordinary
  // token edits don't stomp on what the user is typing.
  useEffect(() => {
    if (!serverText) return;
    setTextContent(serverText);
  }, [documentId, serverText]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [textContent]);

  useEffect(() => {
    // The text editor does structural edits (text body, tokenization) that
    // aren't optimistic-concurrency-gated. Make sure no leaked strict mode (from
    // a previously-open annotation editor) attaches a stale document-version and
    // makes Tokenize / Save fail with a spurious 409.
    const client = getClient();
    if (client) client.exitStrictMode();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, documentId]);

  // --- thin wrappers around doc methods, kept for the bits that need to
  // poke TextEditor-local state (originalTokenizedText, lastSaved, etc.). ---

  const handleSaveText = async () => {
    if (!doc) return;
    if (!textContent.trim() || doc.isSaving) return;
    const ok = await doc.saveText(textContent);
    if (ok) {
      setLastSaved(new Date());
      setOriginalTokenizedText(textContent);
    }
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
      title: 'Clear all tokens',
      description: shared
        ? 'These tokens are shared with another app on this project, such as interlinear ' +
          "glossing. Clearing them here also deletes that app's annotations on this " +
          'document. This cannot be undone.'
        : 'This cannot be undone.',
      confirmLabel: 'Clear',
      destructive: true,
    });
    if (!ok) return;
    if (await doc.clearTokens()) setOriginalTokenizedText('');
  };

  const handleWordCreate = async (begin, end) => {
    if (!doc) return;
    const ok = await doc.createWord(begin, end, textContent);
    // After the very first manual creation, treat the current text as the
    // tokenized baseline (mirrors tokenize) so the dirty banner doesn't fire
    // just because tokens now exist.
    if (ok && !originalTokenizedText) setOriginalTokenizedText(textContent);
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
      title: 'Delete token',
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

  const isTextDirty = originalTokenizedText && textContent !== originalTokenizedText;
  const hasTokens = sentenceTokens.length > 0 || wordTokens.length > 0 || morphemeTokens.length > 0;

  // Once the document has tokens, the text those tokens were cut from is what
  // "Unsaved changes" is measured against. Keyed on `hasTokens` as well as the
  // body, so a tokenize run that changes no text still settles the mark.
  useEffect(() => {
    if (!serverText || !hasTokens) return;
    setOriginalTokenizedText((prev) => prev || serverText);
  }, [documentId, serverText, hasTokens]);
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

  const missingLayerLabels = !layerInfo.isConfigured
    ? missingUdLayerLabels(layerInfo.missingLayers)
    : [];

  return (
    <div>
      {!canEdit && (
        <div className="mb-3 rounded-md border border-blue-500/40 bg-blue-500/10 px-3 py-2 text-sm text-blue-900">
          Read-only. You have viewer access to this project.
        </div>
      )}

      {missingLayerLabels.length > 0 && (
        <div className="mb-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-900">
          Project configuration incomplete: {missingLayerLabels.join(', ')}.
        </div>
      )}

      {layersMisconfigured && (
        <div className="mb-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-900">
          This project&rsquo;s token layers have no overlap mode or parent set. Tokenizing still
          works, server-enforced nesting and partitioning do not. Recreate the project to fix it.
        </div>
      )}

      <div className="grid gap-8 lg:grid-cols-2">
        <div className="flex flex-col gap-4">
          <h4 className="text-base font-semibold">Text Content</h4>
          <Textarea
            ref={textareaRef}
            value={textContent}
            spellCheck={false}
            onChange={handleTextChange}
            readOnly={readOnly}
            placeholder={`Enter your text here. Use newlines to separate sentences.

Example:
The quick brown fox jumps over the lazy dog.
This is a second sentence for testing.`}
            rows={12}
            className="resize-none overflow-hidden font-mono leading-relaxed"
          />

          <div className="flex items-center gap-3">
            {!readOnly && (
              <Button
                className="bg-emerald-600 text-white hover:bg-emerald-700"
                onClick={handleSaveText}
                disabled={saving || !textContent.trim()}
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

            {!readOnly && hasTokens && (
              <Button variant="destructive" onClick={handleClearTokens} disabled={saving}>
                Clear tokens
              </Button>
            )}

            <span className="ml-auto text-sm font-medium text-muted-foreground">
              {wordTokens.length} token{wordTokens.length !== 1 ? 's' : ''}, {sentenceTokens.length}{' '}
              sentence{sentenceTokens.length !== 1 ? 's' : ''}
            </span>
          </div>

          <p className="text-sm">
            {saving && <span className="italic text-blue-600">Saving…</span>}
            {!saving && lastSaved && (
              <span className="text-emerald-600">Saved: {lastSaved.toLocaleTimeString()}</span>
            )}
            {!saving && !lastSaved && textContent && isTextDirty && (
              <span className="italic text-amber-700">Unsaved changes</span>
            )}
          </p>
        </div>

        <div className="rounded-md border bg-muted/40 p-4">
          <h4 className="mb-4 text-base font-semibold">Token Visualization</h4>
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
            setError={(msg) => doc.setError(msg)}
          />
        </div>
      </div>
    </div>
  );
};
