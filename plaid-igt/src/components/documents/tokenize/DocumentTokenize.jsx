import { useEffect, useState, useRef } from 'react';
import { Info, Play, ChevronUp, Scissors, HelpCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select';
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  TooltipProvider,
} from '@/components/ui/tooltip';
import { useTokenOperations } from './useTokenOperations.js';
import { useDocumentCtx } from '../contexts/DocumentContext.jsx';
import { useIgtDocument } from '../../../domain/useIgtDocument.js';
import Lazy from '../../lazy';
import './DocumentTokenize.css';

export function DocumentTokenize() {
  const { doc, readOnly } = useDocumentCtx();
  useIgtDocument(doc);
  const ops = useTokenOperations();

  const sentences = doc.sentences;
  const layers = doc.layerInfo;
  const text = doc.document.text;
  const project = doc.project;
  const existingTokens = sentences?.flatMap((s) => s.tokens || []) || [];
  const existingSentenceTokens = sentences || [];
  // Word layer is :non-overlapping nested under sentence — every word token must be contained
  // in a sentence partition. Gate the UI so the user saves baseline text first if missing.
  const hasSentencePartition = existingSentenceTokens.length > 0;

  const [helpOpen, setHelpOpen] = useState(false);

  // Drag-to-merge selection state. Mirrored into a ref so synchronous DOM event
  // handlers (mousedown→mouseup→click) read the latest value without waiting for
  // a React re-render — preserving the old valtio synchronous semantics (esp. so
  // the trailing `click` after a plain press sees the drag already cleared).
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

  const handleAlgorithmDropdownClick = async () => {
    if (!project?.id || ops.isDiscovering) return;
    await ops.discoverServices(project.id);
  };

  return (
    <TooltipProvider>
      <div className="tw flex flex-col gap-6 mt-4" style={{ height: 'calc(100vh - 200px)' }}>
        {/* Text Visualization */}
        <div className="rounded-lg border bg-card" style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
          <div className="p-4" style={{ borderBottom: '1px solid #e0e0e0' }}>
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

            {helpOpen && (
              <div>
                <p className="text-sm mb-2 mt-2">
                  Existing tokens are highlighted. Untokenized text appears as plain text.
                </p>
                <div className="flex flex-col gap-[0.4rem] mb-2">
                  <div>
                    <kbd className="rounded border bg-muted px-1.5 py-0.5 text-xs">Left Click</kbd> + <kbd className="rounded border bg-muted px-1.5 py-0.5 text-xs">Drag</kbd>: Create token from selection, or merge tokens
                  </div>
                  <div>
                    <kbd className="rounded border bg-muted px-1.5 py-0.5 text-xs">Left Click</kbd>: Split Token
                  </div>
                  <div>
                    <kbd className="rounded border bg-muted px-1.5 py-0.5 text-xs">Right Click</kbd>: Delete Token
                  </div>
                  <div>
                    <kbd className="rounded border bg-muted px-1.5 py-0.5 text-xs">Ctrl</kbd>/<kbd className="rounded border bg-muted px-1.5 py-0.5 text-xs">Cmd</kbd> + <kbd className="rounded border bg-muted px-1.5 py-0.5 text-xs">Left Click</kbd> on token: New Sentence
                  </div>
                  <div>
                    <kbd className="rounded border bg-muted px-1.5 py-0.5 text-xs"><ChevronUp className="h-3 w-3 inline" /></kbd>: Merge sentence with previous
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Sentence rendering */}
          <div className="sentence-container">
            {!hasSentencePartition && !readOnly && (
              <div className="m-4 rounded-md border border-yellow-500/50 bg-yellow-500/5 p-3">
                <div className="flex items-start gap-2">
                  <Info className="h-4 w-4 mt-0.5 shrink-0 text-yellow-600" />
                  <div>
                    <p className="text-sm font-medium">No sentence partition</p>
                    <p className="text-sm text-muted-foreground">
                      Save baseline text first to enable tokenization. Word-level tokens must live
                      inside a sentence partition, which is created when you save baseline text.
                    </p>
                  </div>
                </div>
              </div>
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
              />
            ))}
          </div>
        </div>

        {/* NLP Controls Panel */}
        <div
          className="rounded-lg border bg-card p-4"
          style={{ flexShrink: 0 }}
          onMouseEnter={() => ops.discoverServices(project?.id)}
        >
          <div className="flex items-end justify-between flex-wrap gap-2 mb-4">
            <div className="flex items-end gap-3">
              <div className="flex flex-col gap-1.5" onMouseEnter={handleAlgorithmDropdownClick}>
                <Label>Tokenization Algorithm</Label>
                <Select value={ops.algorithm} onValueChange={ops.setAlgorithm} disabled={readOnly}>
                  <SelectTrigger style={{ width: 280 }}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ops.algorithmOptions.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value}>
                        {opt.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <Button
                onClick={ops.handleTokenize}
                disabled={ops.isTokenizing || ops.isProcessing || !text?.body || !layers?.primaryTokenLayer || !hasSentencePartition || readOnly}
              >
                <Play className="h-4 w-4" />
                {(ops.isTokenizing || ops.isProcessing) ? 'Tokenizing...' : 'Tokenize'}
              </Button>
            </div>

            <div className="flex items-end gap-3">
              <Button
                variant="secondary"
                onClick={ops.handleClearTokens}
                disabled={ops.isTokenizing || ops.isProcessing || !existingTokens.length || readOnly}
              >
                Clear Tokens
              </Button>

              <Button
                variant="secondary"
                onClick={ops.handleClearSentences}
                disabled={ops.isTokenizing || ops.isProcessing || !existingSentenceTokens.length || existingSentenceTokens.length === 1 || readOnly}
              >
                Clear Sentences
              </Button>
            </div>
          </div>

          {/* Progress */}
          <div className="rounded-lg border bg-card p-4" style={{ minHeight: '120px' }}>
            {(ops.isTokenizing || ops.isProcessing) ? (
              <div className="flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  <Play className="h-4 w-4" />
                  <p className="font-medium">{ops.progressMessage || 'Processing...'}</p>
                </div>
                <div className="h-2 w-full rounded-full bg-muted">
                  <div className="h-full rounded-full bg-primary" style={{ width: `${ops.progressPercent || ops.tokenizationProgress}%` }} />
                </div>
                <p className="text-sm text-muted-foreground">{ops.currentOperation}</p>
              </div>
            ) : (
              <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <p className="text-sm text-muted-foreground"></p>
              </div>
            )}
          </div>

          {!layers?.primaryTokenLayer && (
            <>
              <div className="border-t mt-4" />
              <div className="mt-4 rounded-md border border-destructive/50 bg-destructive/5 p-3">
                <div className="flex items-start gap-2">
                  <Info className="h-4 w-4 mt-0.5 shrink-0 text-destructive" />
                  <p className="text-sm text-destructive">
                    Missing primary token layer. Please ensure your project has a primary token layer configured.
                  </p>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </TooltipProvider>
  );
}

function SentenceComponent({ sentence, ops, index, drag, setDrag, dragRef, readOnly = false }) {
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
    <Lazy className="sentence-row" contentPreview={preview}>
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

function TokenComponent({ ops, sentence, piece, pieceIndex, drag, setDrag, dragRef, readOnly = false }) {
  const [isSplitting, setIsSplitting] = useState(false);
  const isDraggingHere = drag?.sentenceId === sentence.id;
  const isSelected = isDraggingHere && drag.selectedTokenIds.has(piece.id);

  const handleClick = async (e) => {
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
    if (readOnly || e.button !== 0) return;
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
      className={`token ${isDraggingHere ? 'token-dragging' : ''}`}
      style={{
        backgroundColor: isSelected ? '#1976d2' : '#e3f2fd',
        color: isSelected ? 'white' : 'inherit',
        border: `1px solid ${isSelected ? '#1565c0' : '#bbdefb'}`,
        cursor: readOnly ? 'default' : (isDraggingHere ? 'grabbing' : 'pointer'),
      }}
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

  const chars = Array.from(token.content);
  return (
    <span className="splitter-box" onMouseLeave={close}>
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
