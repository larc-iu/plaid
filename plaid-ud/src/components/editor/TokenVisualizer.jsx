import { useState, useRef, useMemo } from 'react';
import { Alert, Text } from '@mantine/core';
import { cpLength, cpSlice, cpIndexOf, utf16ToCp } from '@larc-iu/plaid-client';
import { containsToken } from '../../utils/udLayerUtils.js';
import { notifyError } from '../../utils/feedback.jsx';
import classes from './TokenVisualizer.module.css';

// Raw-text overlay editor for the three-layer token hierarchy. The editable
// surface is the WORD layer (rendered as badges over the document text); a word
// with more than one morpheme is a multiword token (orange), edited via the
// morpheme editor. Sentences are shown by a green border on each sentence's
// first word and toggled by clicking a word (split/merge server-side).
//
// Affordances: select text to create a word, hover tooltip (id / range /
// text), morpheme editor, delete, and a live preview that relocates words when
// the document text is edited after tokenization. There is deliberately NO
// word-resize affordance: a resize keeps token identity while changing what
// the token means, so annotations (incl. other apps' glosses on a shared
// substrate) silently drift onto different text. Boundary fixes are
// delete + re-create, which routes through the foreign-annotation warning.
export const TokenVisualizer = ({
  text = '',
  originalText = '',
  sentenceTokens = [],
  wordTokens = [],
  morphemeTokens = [],
  morphemeForms = new Map(),
  onWordCreate,
  onWordDelete,
  onSentenceToggle,
  onSetWordMorphemes,
  setError
}) => {
  // Prefer the parent's error banner for inline validation errors; fall back to
  // a toast if the prop isn't wired.
  const reportError = (msg) => {
    if (typeof setError === 'function') setError(msg);
    else notifyError(msg);
  };
  const [hoveredWord, setHoveredWord] = useState(null);
  const [morphemeWord, setMorphemeWord] = useState(null);
  const [draftForms, setDraftForms] = useState([]);
  const closeTimeoutRef = useRef(null);
  const textContainerRef = useRef(null);

  const isTextDirty = Boolean(originalText) && text !== originalText;
  const contains = containsToken;
  const sortPos = (a, b) => (a.begin - b.begin) || (a.end - b.end) || ((a.precedence ?? 0) - (b.precedence ?? 0));

  // Morphemes per word (server positions), and which words begin a sentence.
  // Memoized — fix #10: avoid recomputing the read model on every render.
  const sortedMorphemes = useMemo(
    () => [...morphemeTokens].sort(sortPos),
    [morphemeTokens]
  );
  const morphemesByWord = useMemo(
    () => new Map(wordTokens.map(w => [w.id, sortedMorphemes.filter(m => contains(w, m))])),
    [wordTokens, sortedMorphemes]
  );
  const sentenceBegins = useMemo(
    () => new Set(sentenceTokens.map(s => s.begin)),
    [sentenceTokens]
  );
  const sentenceInitialWordIds = useMemo(
    () => new Set(wordTokens.filter(w => sentenceBegins.has(w.begin)).map(w => w.id)),
    [wordTokens, sentenceBegins]
  );

  const formOf = (m, word) => {
    const f = morphemeForms.get(m.id);
    return (f != null && f !== '') ? f : cpSlice(text, word.begin, word.end);
  };

  // --- hover tooltip timing ---
  // Open the tooltip only after the cursor lingers on a badge for a moment.
  // Pass-overs through multiple badges should NOT flash tooltips on each;
  // only deliberate stops should. This also kills a class of "opens then
  // immediately closes" bugs caused by deferred close timers from earlier
  // badges firing after a rapid-traverse hand-off.
  const HOVER_OPEN_DELAY_MS = 120;
  // After cursor leaves the badge, give the user time to reach the tooltip
  // (which sits below the badge). 500ms is the lower bound; tighten if it
  // starts to feel sticky.
  const HOVER_CLOSE_DELAY_MS = 500;
  // Once the mouse is INSIDE the tooltip, leaving its edge for a moment
  // (e.g. mousing past a button) shouldn't dismiss it instantly either.
  const TOOLTIP_LEAVE_DELAY_MS = 250;
  // When a popup (the morpheme editor) closes, the cursor is
  // usually still over the badge, so removing the popup fires a mouseenter on
  // the badge and the tooltip pops back up. Suppress hover-opens for a short
  // window after an explicit close so Save/Cancel actually dismisses the UI.
  const SUPPRESS_HOVER_MS = 600;
  const suppressHoverUntilRef = useRef(0);
  const suppressHover = () => { suppressHoverUntilRef.current = Date.now() + SUPPRESS_HOVER_MS; };

  const cancelPendingTimer = () => {
    if (closeTimeoutRef.current) {
      clearTimeout(closeTimeoutRef.current);
      closeTimeoutRef.current = null;
    }
  };
  const handleWordMouseEnter = (word) => {
    if (isTextDirty) return;
    if (Date.now() < suppressHoverUntilRef.current) return;
    cancelPendingTimer();
    // If the tooltip is already open for this word, keep it open. Otherwise
    // schedule an open — gated so quick traversals don't blink tooltips.
    if (hoveredWord && hoveredWord.id === word.id) return;
    closeTimeoutRef.current = setTimeout(() => {
      closeTimeoutRef.current = null;
      setHoveredWord(word);
    }, HOVER_OPEN_DELAY_MS);
  };
  const handleWordMouseLeave = () => {
    cancelPendingTimer();
    // Only schedule a close if a tooltip is currently open. (If the user
    // never lingered, there's nothing to close.)
    if (!hoveredWord) return;
    closeTimeoutRef.current = setTimeout(() => {
      closeTimeoutRef.current = null;
      setHoveredWord(null);
    }, HOVER_CLOSE_DELAY_MS);
  };
  const handleTooltipMouseEnter = () => {
    cancelPendingTimer();
  };
  const handleTooltipMouseLeave = () => {
    cancelPendingTimer();
    closeTimeoutRef.current = setTimeout(() => {
      closeTimeoutRef.current = null;
      setHoveredWord(null);
    }, TOOLTIP_LEAVE_DELAY_MS);
  };

  const handleDeleteClick = async (word) => {
    setHoveredWord(null);
    try {
      await onWordDelete?.(word.id);
    } catch (e) {
      console.error('Word delete failed:', e);
    }
  };

  // --- morpheme editor (multiword tokens) ---
  const openMorphemeEditor = (word) => {
    const ms = morphemesByWord.get(word.id) || [];
    setDraftForms(ms.length ? ms.map(m => formOf(m, word)) : [cpSlice(text, word.begin, word.end)]);
    setMorphemeWord(word);
    setHoveredWord(null);
  };
  const cancelMorphemes = () => {
    setMorphemeWord(null);
    setDraftForms([]);
    setHoveredWord(null);
    cancelPendingTimer();
    suppressHover();
  };
  const saveMorphemes = async () => {
    const forms = draftForms.map(f => f.trim()).filter(Boolean);
    const word = morphemeWord;
    cancelMorphemes();
    if (forms.length && onSetWordMorphemes) {
      try { await onSetWordMorphemes(word, forms); } catch (e) { console.error('Set morphemes failed:', e); }
    }
  };

  // --- select text -> create word --- (offsets mapped via a TreeWalker that
  // skips overlay nodes so only the linear document text is measured)
  const handleTextSelection = () => {
    if (!onWordCreate || isTextDirty) return;
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    if (!range || range.collapsed) return;
    const container = textContainerRef.current;
    if (!container || !container.contains(range.commonAncestorContainer)) return;
    const selectedText = range.toString();
    if (!selectedText) return;

    const map = [];
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) =>
        node.parentElement && node.parentElement.closest('.tv-overlay')
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_ACCEPT
    });
    let pos = 0;
    let node;
    while ((node = walker.nextNode())) {
      for (let i = 0; i < node.textContent.length; i++) {
        map.push({ node, offset: i, pos });
        pos += 1;
      }
    }

    let start = -1;
    let end = -1;
    for (const m of map) {
      if (m.node === range.startContainer && m.offset === range.startOffset) start = m.pos;
      if (m.node === range.endContainer && m.offset === range.endOffset) { end = m.pos; break; }
    }
    if (end === -1 && range.endContainer.nodeType === Node.TEXT_NODE) {
      for (const m of map) {
        if (m.node === range.endContainer && m.offset === range.endOffset - 1) { end = m.pos + 1; break; }
      }
    }
    // Fall back to first occurrence if the DOM walk didn't line up.
    if (start === -1 || end === -1 || start >= end || text.slice(start, end) !== selectedText) {
      const idx = text.indexOf(selectedText);
      if (idx === -1) return;
      start = idx;
      end = idx + selectedText.length;
    }

    // The DOM walk + indexOf above produce UTF-16 positions in the rendered
    // text (which equals the body); convert to canonical code-point offsets
    // before comparing to token offsets / sending to the server.
    start = utf16ToCp(text, start);
    end = utf16ToCp(text, end);

    if (wordTokens.some(w => start < w.end && end > w.begin)) {
      reportError('Cannot create word: selection overlaps an existing word');
      return;
    }
    onWordCreate(start, end);
    selection.removeAllRanges();
  };

  // --- live relocation of words when the text is edited after tokenization ---
  // Memoized — fix #11: this is O(words × occurrences) and was running per render.
  const adjustedWords = useMemo(() => {
    const words = wordTokens;
    const original = originalText;
    const current = text;
    if (!original || original === current) return words;
    // Work in code points (token offsets are code points). Compare code-point
    // sequences so editPos / lengthDiff / search indices are all code-point.
    const oCps = Array.from(original);
    const cCps = Array.from(current);
    const curLen = cCps.length;
    let editPos = 0;
    while (editPos < Math.min(oCps.length, cCps.length) && oCps[editPos] === cCps[editPos]) editPos += 1;
    const lengthDiff = cCps.length - oCps.length;

    return words.map(word => {
      const wordText = cpSlice(original, word.begin, word.end);
      if (word.end <= editPos) return word;
      if (word.begin >= editPos) {
        const nb = word.begin + lengthDiff;
        const ne = word.end + lengthDiff;
        if (nb >= 0 && ne <= curLen && cpSlice(current, nb, ne) === wordText) {
          return { ...word, begin: nb, end: ne, adjusted: true };
        }
      }
      // search for the word text near its old position
      let best = null;
      let bestScore = -1;
      let from = 0;
      while (true) {
        const idx = cpIndexOf(current, wordText, from);
        if (idx === -1) break;
        const score = 1000 - Math.abs(idx - word.begin);
        if (score > bestScore) { bestScore = score; best = { begin: idx, end: idx + cpLength(wordText) }; }
        from = idx + 1;
      }
      if (best) return { ...word, begin: best.begin, end: best.end, adjusted: true };
      return { ...word, invalid: true };
    });
  }, [wordTokens, originalText, text]);

  if (!text) {
    return <Text ta="center" py="xl" c="dimmed">No text to visualize</Text>;
  }

  if (wordTokens.length === 0) {
    return (
      <div>
        <div
          ref={textContainerRef}
          className={`${classes.container} ${classes.rawText}`}
          onMouseUp={handleTextSelection}
        >
          {text}
        </div>
        <p className={classes.emptyHint}>
          No tokens yet. Click &quot;Basic Tokenize&quot; to create the hierarchy, or select text to create a word.
        </p>
      </div>
    );
  }

  const renderWordBadge = (word) => {
    const wordText = cpSlice(text, word.begin, word.end);
    const display = word.begin === word.end ? '∅' : wordText;
    const isSentStart = sentenceInitialWordIds.has(word.id);
    const morphs = morphemesByWord.get(word.id) || [];
    const isMwt = morphs.length > 1;

    return (
      <span
        key={`w-${word.id}`}
        className={classes.badge}
        data-mwt={isMwt}
        data-sent-start={isSentStart}
        onMouseEnter={() => handleWordMouseEnter(word)}
        onMouseLeave={handleWordMouseLeave}
        onClick={async () => {
          if (isTextDirty || !onSentenceToggle) return;
          try {
            await onSentenceToggle(word.begin);
            setHoveredWord(null);
          } catch (e) {
            console.error('Failed to toggle sentence boundary:', e);
          }
        }}
      >
        {display}

        {hoveredWord && hoveredWord.id === word.id && !morphemeWord && (
          // Overlap the badge by a few px (negative top margin) so the mouse
          // can travel from badge to tooltip without crossing empty row-gap
          // — that gap occasionally hits a sibling badge mid-traverse and
          // pre-empts the hover-close delay, swapping to the wrong tooltip.
          <div
            className={`tv-overlay ${classes.tooltip}`}
            onMouseEnter={handleTooltipMouseEnter}
            onMouseLeave={handleTooltipMouseLeave}
            onClick={(e) => e.stopPropagation()}
          >
            <div className={classes.tooltipMeta}>
              <div className={classes.tooltipTitle}>Word {String(word.id).slice(0, 8)}</div>
              <div className={classes.tooltipDim}>Range: [{word.begin}-{word.end}]</div>
              <div className={classes.tooltipDim}>Text: &quot;{wordText}&quot;</div>
              {isMwt && <div className={classes.tooltipMorph}>Morphemes: {morphs.map(m => formOf(m, word)).join(' + ')}</div>}
            </div>

            {onSentenceToggle && (
              <label
                className={classes.tooltipSentToggle}
                onClick={(e) => e.stopPropagation()}
              >
                <input
                  type="checkbox"
                  checked={isSentStart}
                  onClick={(e) => e.stopPropagation()}
                  onChange={async () => {
                    try { await onSentenceToggle(word.begin); setHoveredWord(null); }
                    catch (e) { console.error('Failed to toggle sentence boundary:', e); }
                  }}
                />
                <span className={classes.tooltipSentLabel}>Start of sentence</span>
              </label>
            )}

            <div className={classes.tooltipActions}>
              {onSetWordMorphemes && (
                <button onClick={() => openMorphemeEditor(word)} className={`${classes.tipBtn} ${classes.tipBtnMorph}`}>Morphemes</button>
              )}
              <button onClick={() => handleDeleteClick(word)} className={`${classes.tipBtn} ${classes.tipBtnDelete}`}>Delete</button>
            </div>
          </div>
        )}

        {morphemeWord && morphemeWord.id === word.id && (
          <div
            className={`tv-overlay ${classes.popover} ${classes.popoverLeft}`}
            onClick={(e) => e.stopPropagation()}
          >
            <div className={classes.popoverTitle}>Morphemes of &quot;{cpSlice(text, word.begin, word.end)}&quot;</div>
            <div className={classes.popoverHint}>One form = an ordinary word; multiple = a multiword token.</div>
            <div className={classes.morphList}>
              {draftForms.map((form, i) => (
                <div key={i} className={classes.morphRow}>
                  <input
                    type="text"
                    value={form}
                    onChange={(e) => setDraftForms(prev => prev.map((f, idx) => (idx === i ? e.target.value : f)))}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); saveMorphemes(); } else if (e.key === 'Escape') { e.preventDefault(); cancelMorphemes(); } }}
                    className={classes.morphInput}
                    autoFocus={i === draftForms.length - 1}
                  />
                  {draftForms.length > 1 && (
                    <button onClick={() => setDraftForms(prev => prev.filter((_, idx) => idx !== i))} className={classes.morphRemove} title="Remove morpheme">×</button>
                  )}
                </div>
              ))}
            </div>
            <div className={classes.morphFooter}>
              <button onClick={() => setDraftForms(prev => [...prev, ''])} className={classes.addMorph}>+ morpheme</button>
              <div className={classes.morphActions}>
                <button onClick={cancelMorphemes} className={classes.miniCancel}>Cancel</button>
                <button onClick={saveMorphemes} className={classes.miniSave}>Save</button>
              </div>
            </div>
          </div>
        )}
      </span>
    );
  };

  const renderText = () => {
    const adjusted = adjustedWords;
    const valid = adjusted.filter(w => !w.invalid).sort((a, b) => a.begin - b.begin);
    const invalid = adjusted.filter(w => w.invalid);

    // Group words into sentences (a word that begins a sentence starts a block).
    const sentences = [];
    let current = [];
    valid.forEach(word => {
      if (sentenceInitialWordIds.has(word.id) && current.length) { sentences.push(current); current = []; }
      current.push(word);
    });
    if (current.length) sentences.push(current);
    if (!sentences.length && valid.length) sentences.push(valid);

    let lastEnd = 0;
    const blocks = sentences.map((words, si) => {
      const els = [];
      words.forEach((word, wi) => {
        if (word.begin > lastEnd) {
          els.push(<span key={`bt-${si}-${wi}`} className={classes.plainText}>{cpSlice(text, lastEnd, word.begin)}</span>);
        }
        els.push(renderWordBadge(word));
        lastEnd = Math.max(lastEnd, word.end);
      });
      return <div key={`s-${si}`} className={classes.sentence}>{els}</div>;
    });

    if (lastEnd < cpLength(text)) {
      blocks.push(<div key="trail" className={classes.plainText}>{cpSlice(text, lastEnd)}</div>);
    }
    if (invalid.length) {
      blocks.push(
        <div key="invalid" className={classes.invalidNote}>
          {invalid.length} word{invalid.length !== 1 ? 's' : ''} no longer match the edited text — save and re-tokenize to resync.
        </div>
      );
    }
    return blocks;
  };

  return (
    <div>
      {isTextDirty && (
        <Alert color="yellow" mb="xs" p="xs">
          Showing token positions relocated for your unsaved edits. Save the text to apply.
        </Alert>
      )}
      <div
        ref={textContainerRef}
        className={classes.container}
        onMouseUp={handleTextSelection}
      >
        {renderText()}
      </div>
      <p className={classes.hint}>
        Click a word to toggle a sentence boundary; hover for Morphemes / Delete; select text to create a word.
        With a word hovered, <code>s</code>/<code>S</code> move its start, <code>d</code>/<code>D</code> move its end.
      </p>
    </div>
  );
};
