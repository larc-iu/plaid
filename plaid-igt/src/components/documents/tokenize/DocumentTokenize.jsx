import { useEffect, useState, useRef } from 'react';
import { Info, ChevronUp, Scissors, HelpCircle } from 'lucide-react';
import { Button } from '@ui/components/ui/button';
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  TooltipProvider,
} from '@ui/components/ui/tooltip';
import { useTokenOperations } from './useTokenOperations.js';
import { ConfirmDeleteDialog } from '@ui/components/shared/ConfirmDeleteDialog';
import { Notice } from '@ui/components/shared/Notice.jsx';
import { DELETE_BUTTON_CLASS } from '@ui/lib/destructive.js';
import { useConfirm } from '@ui/components/shared/ConfirmProvider';
import { lossPhrase } from '@ui/domain/annotationLoss.js';
import { notifySuccess } from '@/utils/feedback';
import { splitPointsFromSegments } from '@/domain/segments.js';
import { clearSentencesFits, TOO_MANY_SENTENCES } from '@/domain/mutations/sentences.js';
import { useDocumentCtx } from '../contexts/DocumentContext.jsx';
import { useDocumentModel } from '@ui/domain/useDocumentModel.js';
import { TokenizeDialog } from './TokenizeDialog.jsx';
import Lazy from '../../lazy';
import './DocumentTokenize.css';

export function DocumentTokenize() {
  const { doc, readOnly, canWrite, writeLock } = useDocumentCtx();
  useDocumentModel(doc);
  const ops = useTokenOperations();

  const sentences = doc.sentences;
  const layers = doc.layerInfo;
  const text = doc.document.text;
  const existingTokens = sentences?.flatMap((s) => s.tokens || []) || [];
  const existingSentenceTokens = sentences || [];
  // Word layer is :non-overlapping nested under sentence — every word token must be contained
  // in a sentence partition. Gate the UI so the user saves baseline text first if missing.
  const hasSentencePartition = existingSentenceTokens.length > 0;

  const [helpOpen, setHelpOpen] = useState(false);
  // Which bulk clear is awaiting confirmation: 'tokens' | 'sentences' | null.
  const [confirmClear, setConfirmClear] = useState(null);
  const confirm = useConfirm();

  // Coming from the Analyze tab: land on the sentence whose cell was focused
  // there and flash the word, the way Analyze lands on a word from here. The
  // row may still be a lazy placeholder, so it is scrolled to first, which
  // makes it render, and the word is looked for a frame later.
  useEffect(() => {
    let req = null;
    try {
      req = JSON.parse(sessionStorage.getItem('igt:focus-tokenize') || 'null');
    } catch {
      /* noop */
    }
    if (!req || req.docId !== doc.id) return undefined;
    const row = document.querySelector(`.sentence-row[data-sentence-id="${req.sentenceId}"]`);
    // The key goes only once the landing is done (or given up on): in
    // development React runs a mount effect, cleans it up and runs it again,
    // and a key taken on the first run would leave the second with nothing.
    const done = () => sessionStorage.removeItem('igt:focus-tokenize');
    if (!row) {
      done();
      return undefined;
    }
    row.scrollIntoView({ block: 'center' });
    row.classList.add('sentence-flash');
    // The row renders its words once it has been scrolled into view, a frame
    // or two later, so the word is looked for until it is there.
    let tries = 0;
    const timers = [];
    const flashWord = () => {
      const word =
        req.begin == null ? null : row.querySelector(`.token[data-begin="${req.begin}"]`);
      if (word) word.classList.add('token-flash');
      if (word || req.begin == null || tries++ >= 20) done();
      else timers.push(setTimeout(flashWord, 50));
    };
    flashWord();
    timers.push(
      setTimeout(() => {
        row.classList.remove('sentence-flash');
        row.querySelector('.token-flash')?.classList.remove('token-flash');
      }, 2500),
    );
    return () => timers.forEach(clearTimeout);
    // Once, on mount: a later render must not re-read a key already consumed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // One sentence per segment: the sentence breaks follow the cuts made on the
  // Media tab. Splits only, and never through a word.
  const segmentSplits = splitPointsFromSegments({
    sentences: sentences || [],
    words: (sentences || []).flatMap((s) => s.tokens || []),
    alignments: doc.alignmentTokens || [],
  });
  const splitAtSegments = async () => {
    const { positions, insideWord } = segmentSplits;
    const n = positions.length;
    const lost = lossPhrase(doc.sentenceSplitLoss(positions));
    const ok = await confirm({
      title: 'Split sentences at segments?',
      description:
        `${n} sentence break${n === 1 ? '' : 's'} will be added where segments start.` +
        (insideWord
          ? ` ${insideWord} segment${insideWord === 1 ? ' starts' : 's start'} inside a word and ${insideWord === 1 ? 'is' : 'are'} left alone.`
          : '') +
        (lost ? ` Deletes ${lost} that cross the new break${n === 1 ? '' : 's'}.` : ''),
      confirmLabel: 'Split sentences',
    });
    if (!ok) return;
    if (await ops.splitSentencesAt(positions)) {
      notifySuccess(`Added ${n} sentence break${n === 1 ? '' : 's'}`, 'Sentences split');
    }
  };

  const busy = ops.isTokenizing || ops.isProcessing || !!writeLock;
  // Why Tokenize cannot run, stated in the dialog rather than left to a
  // disabled button with no explanation. Null means it can.
  const tokenizeBlockedHint = !layers?.primaryTokenLayer
    ? 'This project is not set up for words.'
    : !text?.body
      ? 'This document has no text yet.'
      : !hasSentencePartition
        ? 'The text has no sentences yet. Save it again on the Baseline tab.'
        : null;

  // Drag-to-merge selection state. Mirrored into a ref so synchronous DOM event
  // handlers (mousedown→mouseup→click) read the latest value without waiting for
  // a React re-render, so the trailing `click` after a plain press sees the
  // drag already cleared.
  const [drag, setDragState] = useState(null); // { sentenceId, startToken:{id,begin,end}, selectedTokenIds:Set } | null
  const dragRef = useRef(null);
  const setDrag = (next) => {
    dragRef.current = next;
    setDragState(next);
  };

  const mergeRef = useRef(ops.mergeTokens);
  mergeRef.current = ops.mergeTokens;

  // Global mouseup ends any active drag; merges if >1 token was selected.
  useEffect(() => {
    const handleGlobalMouseUp = async () => {
      const d = dragRef.current;
      if (!d) return;
      const ids = d.selectedTokenIds;
      setDrag(null);
      if (!readOnly && ids.size > 1) {
        await mergeRef.current(ids);
      }
    };
    window.addEventListener('mouseup', handleGlobalMouseUp);
    return () => window.removeEventListener('mouseup', handleGlobalMouseUp);
  }, [readOnly]);

  return (
    <TooltipProvider>
      <div className="flex flex-col gap-6 mt-4">
        {/* Text Visualization */}
        <div
          className="rounded-lg border bg-card"
          style={{ flex: 1, display: 'flex', flexDirection: 'column' }}
        >
          <div className="border-b p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <h3 className="text-base font-semibold">Tokens</h3>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-muted-foreground"
                      onClick={() => setHelpOpen((v) => !v)}
                    >
                      <HelpCircle className="h-5 w-5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{helpOpen ? 'Hide help' : 'Show help'}</TooltipContent>
                </Tooltip>
              </div>

              {/* On canWrite, not readOnly: a run of its own takes the
                  document read-only, and the button carrying that run's
                  progress must not vanish with it. */}
              {canWrite && (
                <div className="flex items-center gap-2">
                  <TokenizeDialog ops={ops} blockedHint={tokenizeBlockedHint} />
                  <Button
                    variant="outline"
                    className={DELETE_BUTTON_CLASS}
                    onClick={() => setConfirmClear('tokens')}
                    disabled={busy || !existingTokens.length}
                  >
                    Clear tokens
                  </Button>
                  <Button
                    variant="outline"
                    className={DELETE_BUTTON_CLASS}
                    onClick={() => setConfirmClear('sentences')}
                    disabled={
                      busy || !existingSentenceTokens.length || existingSentenceTokens.length === 1
                    }
                  >
                    Reset sentences
                  </Button>
                  <Button
                    variant="outline"
                    onClick={splitAtSegments}
                    disabled={busy || !segmentSplits.positions.length}
                  >
                    Split at segments
                  </Button>
                </div>
              )}
            </div>

            {helpOpen && (
              <div>
                <p className="text-sm mb-2 mt-2">
                  Existing tokens are highlighted. Untokenized text appears as plain text.
                </p>
                <div className="flex flex-col gap-[0.4rem] mb-2">
                  <div>
                    <kbd className="rounded border bg-muted px-1.5 py-0.5 text-xs">Left click</kbd>{' '}
                    + <kbd className="rounded border bg-muted px-1.5 py-0.5 text-xs">Drag</kbd>:
                    Create token from selection, or merge tokens
                  </div>
                  <div>
                    <kbd className="rounded border bg-muted px-1.5 py-0.5 text-xs">Left click</kbd>:
                    Split token
                  </div>
                  <div>
                    <kbd className="rounded border bg-muted px-1.5 py-0.5 text-xs">Esc</kbd>: Close
                    the split points
                  </div>
                  <div>
                    <kbd className="rounded border bg-muted px-1.5 py-0.5 text-xs">Right click</kbd>
                    : Delete token
                  </div>
                  <div>
                    <kbd className="rounded border bg-muted px-1.5 py-0.5 text-xs">Ctrl</kbd>/
                    <kbd className="rounded border bg-muted px-1.5 py-0.5 text-xs">Cmd</kbd> +{' '}
                    <kbd className="rounded border bg-muted px-1.5 py-0.5 text-xs">Left click</kbd>{' '}
                    on token: Split sentence here
                  </div>
                  <div>
                    <kbd className="rounded border bg-muted px-1.5 py-0.5 text-xs">Alt</kbd> +{' '}
                    <kbd className="rounded border bg-muted px-1.5 py-0.5 text-xs">Left click</kbd>{' '}
                    on token: Open it in Analyze
                  </div>
                  <div>
                    <ChevronUp className="h-3 w-3 inline" /> button above a sentence: Merge it with
                    the previous sentence
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Sentence rendering */}
          <div className="sentence-container">
            {!hasSentencePartition && !readOnly && (
              <Notice tone="warning" icon={Info} className="m-4 font-sans">
                <p className="font-medium">{text?.body ? 'No sentences yet' : 'No text yet'}</p>
                <p>
                  {text?.body
                    ? 'The text has no sentences. Save it again on the Baseline tab.'
                    : 'Add the text on the Baseline tab first.'}
                </p>
              </Notice>
            )}
            {sentences.map((sentence, index) => (
              <SentenceComponent
                key={sentence.id}
                sentence={sentence}
                ops={ops}
                index={index}
                drag={drag}
                setDrag={setDrag}
                dragRef={dragRef}
                readOnly={readOnly}
                dir={doc.textDirection}
              />
            ))}
          </div>
        </div>

        {!layers?.primaryTokenLayer && (
          <Notice tone="error" icon={Info}>
            This project is not set up for words. A project maintainer can finish setup.
          </Notice>
        )}
      </div>

      {/* Bulk-clear confirmations. Counts come straight from the loaded doc. */}
      <ConfirmDeleteDialog
        open={confirmClear === 'tokens'}
        onOpenChange={(o) => {
          if (!o) setConfirmClear(null);
        }}
        title="Clear all tokens?"
        confirmLabel="Clear"
        onConfirm={() => {
          setConfirmClear(null);
          ops.handleClearTokens();
        }}
      >
        <p>
          Deletes all{' '}
          <strong>
            {existingTokens.length.toLocaleString()} word token
            {existingTokens.length === 1 ? '' : 's'}
          </strong>{' '}
          in this document, with their morphemes and every annotation and vocabulary link on them.
        </p>
        <p>Sentence boundaries and sentence-level annotations are unchanged.</p>
      </ConfirmDeleteDialog>

      <ConfirmDeleteDialog
        open={confirmClear === 'sentences'}
        onOpenChange={(o) => {
          if (!o) setConfirmClear(null);
        }}
        title="Reset sentences?"
        confirmLabel="Reset"
        confirmDisabled={confirmClear === 'sentences' && !clearSentencesFits(layers)}
        onConfirm={() => {
          setConfirmClear(null);
          ops.handleClearSentences();
        }}
      >
        <p>
          Replaces all <strong>{existingSentenceTokens.length.toLocaleString()} sentences</strong>{' '}
          with a single sentence spanning the whole text. Sentence-level annotations (e.g.
          translations) are deleted with their sentences.
        </p>
        <p>Words, morphemes, and their annotations are unchanged.</p>
        {confirmClear === 'sentences' && !clearSentencesFits(layers) && (
          <p className="text-destructive">{TOO_MANY_SENTENCES}</p>
        )}
      </ConfirmDeleteDialog>

      {/* Single-token delete confirm: only opens when the token carries
          annotations (deleteToken deletes unannotated tokens instantly). */}
      <ConfirmDeleteDialog
        open={!!ops.pendingDelete}
        onOpenChange={(o) => {
          if (!o) ops.cancelPendingDelete();
        }}
        title="Delete token?"
        confirmLabel="Delete"
        onConfirm={() => ops.confirmPendingDelete()}
      >
        <p>
          Deleting <strong>“{ops.pendingDelete?.content}”</strong> also deletes{' '}
          <strong>
            {ops.pendingDelete?.annotations || 0} annotation
            {ops.pendingDelete?.annotations === 1 ? '' : 's'}
            {ops.pendingDelete?.links
              ? ` and ${ops.pendingDelete.links} vocabulary link${ops.pendingDelete.links === 1 ? '' : 's'}`
              : ''}
          </strong>{' '}
          on it.
        </p>
      </ConfirmDeleteDialog>

      {/* Split/merge annotation-loss confirm: only opens when the affected
          word(s) carry morpheme-scope annotations the op would destroy
          (split/merge delete the words' morphemes). Word-scope spans survive.
          A sentence split opens it when the new break cuts relations a layer
          rule keeps inside one sentence. */}
      <ConfirmDeleteDialog
        open={!!ops.pendingStructural}
        onOpenChange={(o) => {
          if (!o) ops.cancelPendingStructural();
        }}
        title={
          ops.pendingStructural?.kind === 'merge'
            ? 'Merge words?'
            : ops.pendingStructural?.kind === 'sentence-split'
              ? 'Split sentence?'
              : 'Split word?'
        }
        confirmLabel={ops.pendingStructural?.kind === 'merge' ? 'Merge' : 'Split'}
        onConfirm={() => ops.confirmPendingStructural()}
      >
        {ops.pendingStructural?.kind === 'sentence-split' ? (
          <p>
            Splitting the sentence here deletes <strong>{lossPhrase(ops.pendingStructural)}</strong>{' '}
            that cross the new break.
          </p>
        ) : (
          <p>
            {ops.pendingStructural?.kind === 'merge' ? 'Merging' : 'Splitting'}{' '}
            <strong>“{ops.pendingStructural?.label}”</strong> discards the morpheme analysis,
            deleting{' '}
            <strong>
              {ops.pendingStructural?.annotations || 0} annotation
              {ops.pendingStructural?.annotations === 1 ? '' : 's'}
              {ops.pendingStructural?.links
                ? ` and ${ops.pendingStructural.links} vocabulary link${ops.pendingStructural.links === 1 ? '' : 's'}`
                : ''}
            </strong>{' '}
            at the morpheme level. Word-level annotations are unchanged.
          </p>
        )}
      </ConfirmDeleteDialog>

      {/* Destructive re-tokenize confirm: a tokenizer service run on a
          single-sentence document resets the sentence partition, discarding the
          existing analysis. Only opens when there's something to lose. */}
      <ConfirmDeleteDialog
        open={!!ops.pendingTokenize}
        onOpenChange={(o) => {
          if (!o) ops.cancelPendingTokenize();
        }}
        title="Re-tokenize document?"
        confirmLabel="Re-tokenize"
        onConfirm={() => ops.confirmPendingTokenize()}
      >
        <p>
          {ops.pendingTokenize?.annotations || ops.pendingTokenize?.links ? (
            <>
              Re-tokenizing re-segments this document, discarding{' '}
              <strong>
                {ops.pendingTokenize?.annotations || 0} existing annotation
                {ops.pendingTokenize?.annotations === 1 ? '' : 's'}
                {ops.pendingTokenize?.links
                  ? ` and ${ops.pendingTokenize.links} vocabulary link${ops.pendingTokenize.links === 1 ? '' : 's'}`
                  : ''}
              </strong>{' '}
              (word, morpheme, and sentence level).
            </>
          ) : (
            'Re-tokenizing re-segments this document.'
          )}
          {ops.pendingTokenize?.cut ? (
            <>
              {' '}
              New sentence breaks delete up to{' '}
              <strong>
                {ops.pendingTokenize.cut}
                {ops.pendingTokenize.annotations || ops.pendingTokenize.links ? ' more' : ''}{' '}
                annotation{ops.pendingTokenize.cut === 1 ? '' : 's'}
              </strong>
              .
            </>
          ) : null}
        </p>
      </ConfirmDeleteDialog>
    </TooltipProvider>
  );
}

// The row takes the document's direction, so an Arabic sentence reads from
// the right with its number and merge button at its start.
function SentenceComponent({
  sentence,
  ops,
  index,
  drag,
  setDrag,
  dragRef,
  readOnly = false,
  dir,
}) {
  const handleMerge = async () => {
    await ops.mergeSentence(sentence.id);
  };

  const preview = (
    <div style={{ position: 'relative' }}>
      <div className="sentence-content">{sentence.pieces.map((p) => p.content).join('')}</div>
      <div className="blur-overlay" />
    </div>
  );
  return (
    <Lazy
      className="sentence-row"
      contentPreview={preview}
      data-sentence-id={sentence.id}
      dir={dir}
    >
      <div>
        {/* Sentence number */}
        <div className="text-xs text-muted-foreground sentence-number">{index + 1}</div>

        {/* Merge-with-previous button (not on first sentence) */}
        {index > 0 && !readOnly && (
          <div className="merge-button">
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={handleMerge}
                  className="merge-icon inline-flex items-center justify-center rounded h-5 w-5 text-muted-foreground"
                >
                  <ChevronUp className="h-3 w-3" />
                </button>
              </TooltipTrigger>
              <TooltipContent>Merge with above</TooltipContent>
            </Tooltip>
          </div>
        )}

        {/* Sentence content */}
        <div className="sentence-content">
          {sentence.pieces.map((piece, pieceIndex) =>
            piece.isToken ? (
              <TokenComponent
                key={piece.id}
                sentence={sentence}
                piece={piece}
                pieceIndex={pieceIndex}
                ops={ops}
                drag={drag}
                setDrag={setDrag}
                dragRef={dragRef}
                readOnly={readOnly}
              />
            ) : (
              <span
                key={`${piece.begin}-${piece.end}`}
                className="untokenized"
                onMouseUp={readOnly ? undefined : (e) => ops.createTokenFromSelection(e, piece)}
                title={readOnly ? 'Untokenized text' : 'Select text to create token'}
                style={{ cursor: readOnly ? 'default' : 'text' }}
              >
                {piece.content}
              </span>
            ),
          )}
        </div>
      </div>
    </Lazy>
  );
}

export function TokenComponent({
  ops,
  sentence,
  piece,
  pieceIndex,
  drag,
  setDrag,
  dragRef,
  readOnly = false,
}) {
  const { doc, goToTab } = useDocumentCtx();
  const [isSplitting, setIsSplitting] = useState(false);
  const isDraggingHere = drag?.sentenceId === sentence.id;
  const isSelected = isDraggingHere && drag.selectedTokenIds.has(piece.id);

  const handleClick = async (e) => {
    // Alt+click: the same word on the Analyze tab, where Alt+click on a word
    // comes back here. (A double-click could not do this: the first click
    // replaces the word with the splitter and the second lands on that.) The
    // word was recorded on mousedown, so all that is left is to go there.
    // Works read-only too, since it changes nothing.
    if (e.altKey) {
      e.preventDefault();
      goToTab('analyze');
      return;
    }
    // Read the ref (not the closure) so a trailing click after a press sees the
    // drag already cleared by the global mouseup handler.
    if (readOnly || dragRef.current) return;

    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      if (pieceIndex > 0) {
        await ops.splitSentence(piece.begin);
      }
      return;
    }

    if (piece.content.length > 1) {
      setIsSplitting(true);
    }
  };

  const handleMouseDown = (e) => {
    if (e.button !== 0) return;
    // The last word pressed here is where the Analyze tab opens next, whether
    // by Shift+click or by the tab itself: the island reads this key when it
    // mounts, and a tab switch mounts it. The same key search click-through
    // writes, so the landing (page, scroll, flash, caret) is the same one.
    try {
      sessionStorage.setItem(
        'igt:focus-sentence',
        JSON.stringify({
          docId: doc.id,
          sentenceId: sentence.id,
          begin: piece.begin,
          level: 'word',
        }),
      );
    } catch {
      /* noop */
    }
    if (readOnly) return;
    e.preventDefault();
    setDrag({
      sentenceId: sentence.id,
      startToken: { id: piece.id, begin: piece.begin, end: piece.end },
      selectedTokenIds: new Set([piece.id]),
    });
  };

  const handleMouseEnter = () => {
    const d = dragRef.current;
    if (readOnly || !d || d.sentenceId !== sentence.id || !d.startToken) return;

    const minBegin = Math.min(d.startToken.begin, piece.begin);
    const maxEnd = Math.max(d.startToken.end, piece.end);
    const newSelectedIds = new Set();
    sentence.pieces.forEach((p) => {
      if (p.isToken && p.begin >= minBegin && p.end <= maxEnd) newSelectedIds.add(p.id);
    });
    setDrag({ ...d, selectedTokenIds: newSelectedIds });
  };

  const handleRightClick = async (e) => {
    e.preventDefault();
    if (readOnly) return;
    await ops.deleteToken(piece.id);
  };

  if (isSplitting && !readOnly) {
    return <TokenSplitter ops={ops} token={piece} close={() => setIsSplitting(false)} />;
  }

  return (
    <span
      onClick={handleClick}
      onMouseDown={handleMouseDown}
      onMouseEnter={handleMouseEnter}
      onContextMenu={handleRightClick}
      className={`token ${isSelected ? 'token-selected' : ''} ${isDraggingHere ? 'token-dragging' : ''}`}
      data-begin={piece.begin}
      style={{ cursor: readOnly ? 'default' : isDraggingHere ? 'grabbing' : 'pointer' }}
    >
      {piece.content}
    </span>
  );
}

// Token splitter: click between two chars to split the word at that offset.
function TokenSplitter({ ops, token, close }) {
  async function handleTokenSplit(e, wordOffset) {
    e.stopPropagation();
    close();
    await ops.splitToken(token.id, wordOffset);
  }

  // Escape closes it, wherever focus is: it is open while the pointer rests
  // on the word, and a pointer left there kept it up.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [close]);

  // The letters are boxes in a flex row, which orders them by its direction,
  // so the box takes the word's own: a Latin word or a number in an Arabic
  // sentence reads left to right, as it does in the row around it.
  const chars = Array.from(token.content);
  return (
    <span className="splitter-box" dir="auto" onMouseLeave={close}>
      {chars.map((char, index) => (
        <div key={token.begin + index} className="splitter-char-container">
          <span className="splitter-char">{char}</span>
          {index < chars.length - 1 && (
            <div className="splitter-split-point" onClick={(e) => handleTokenSplit(e, index)}>
              <Scissors className="splitter-icon" size={12} />
            </div>
          )}
        </div>
      ))}
    </span>
  );
}
