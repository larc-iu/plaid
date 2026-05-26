import { useState, useRef, useEffect, useMemo } from 'react';
import { containsToken } from '../../utils/udLayerUtils.js';

// Raw-text overlay editor for the three-layer token hierarchy. The editable
// surface is the WORD layer (rendered as badges over the document text); a word
// with more than one morpheme is a multiword token (orange), edited via the
// morpheme editor. Sentences are shown by a green border on each sentence's
// first word and toggled by clicking a word (split/merge server-side).
//
// Supports the original editor's affordances: select text to create a word,
// hover tooltip (id / range / text), Edit Range, keyboard boundary nudge
// (s/S grow/shrink begin, d/D grow/shrink end), delete, and a live preview that
// relocates words when the document text is edited after tokenization.
export const TokenVisualizer = ({
  text = '',
  originalText = '',
  sentenceTokens = [],
  wordTokens = [],
  morphemeTokens = [],
  morphemeForms = new Map(),
  onWordCreate,
  onWordUpdate,
  onWordDelete,
  onSentenceToggle,
  onSetWordMorphemes,
  setError
}) => {
  // Fix #13: prefer the parent's error banner over `alert()` for inline
  // validation errors. Falls back to alert if the prop isn't wired.
  const reportError = (msg) => {
    if (typeof setError === 'function') setError(msg);
    else alert(msg);
  };
  const [hoveredWord, setHoveredWord] = useState(null);
  const [editingWord, setEditingWord] = useState(null);
  const [editBegin, setEditBegin] = useState('');
  const [editEnd, setEditEnd] = useState('');
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
    return (f != null && f !== '') ? f : text.slice(word.begin, word.end);
  };

  // --- keyboard boundary nudge on the hovered word ---
  // The handler is defined INSIDE the effect so add/remove see the same
  // identity — previously it was recreated on each render and the listener
  // leaked.
  useEffect(() => {
    const handleKeyDown = async (event) => {
      if (!hoveredWord || editingWord || morphemeWord || isTextDirty) return;
      let nb = hoveredWord.begin;
      let ne = hoveredWord.end;
      switch (event.key) {
        case 's': nb -= 1; break;
        case 'S': nb += 1; break;
        case 'd': ne += 1; break;
        case 'D': ne -= 1; break;
        default: return;
      }
      if (nb < 0 || ne > text.length || nb >= ne) return;
      event.preventDefault();
      try {
        await onWordUpdate?.(hoveredWord.id, nb, ne);
        setHoveredWord({ ...hoveredWord, begin: nb, end: ne });
      } catch (e) {
        console.error('Word update failed:', e);
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [hoveredWord, editingWord, morphemeWord, isTextDirty, text, onWordUpdate]);

  // --- hover tooltip timing ---
  const handleWordMouseEnter = (word) => {
    if (isTextDirty) return;
    if (closeTimeoutRef.current) clearTimeout(closeTimeoutRef.current);
    setHoveredWord(word);
  };
  const handleWordMouseLeave = () => {
    closeTimeoutRef.current = setTimeout(() => setHoveredWord(null), 250);
  };
  const handleTooltipMouseEnter = () => {
    if (closeTimeoutRef.current) clearTimeout(closeTimeoutRef.current);
  };
  const handleTooltipMouseLeave = () => setHoveredWord(null);

  // --- boundary edit modal ---
  const handleEditClick = (word) => {
    setEditingWord(word);
    setEditBegin(String(word.begin));
    setEditEnd(String(word.end));
    setHoveredWord(null);
  };
  const handleEditCancel = () => setEditingWord(null);
  const validateAndSave = async () => {
    const nb = parseInt(editBegin, 10);
    const ne = parseInt(editEnd, 10);
    if (Number.isNaN(nb) || Number.isNaN(ne) || nb < 0 || ne > text.length || nb >= ne) {
      reportError('Invalid range');
      return;
    }
    try {
      await onWordUpdate?.(editingWord.id, nb, ne);
      setEditingWord(null);
    } catch (e) {
      console.error('Word update failed:', e);
    }
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
    setDraftForms(ms.length ? ms.map(m => formOf(m, word)) : [text.slice(word.begin, word.end)]);
    setMorphemeWord(word);
    setHoveredWord(null);
  };
  const cancelMorphemes = () => { setMorphemeWord(null); setDraftForms([]); };
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
    let editPos = 0;
    while (editPos < Math.min(original.length, current.length) && original[editPos] === current[editPos]) editPos += 1;
    const lengthDiff = current.length - original.length;

    return words.map(word => {
      const wordText = original.slice(word.begin, word.end);
      if (word.end <= editPos) return word;
      if (word.begin >= editPos) {
        const nb = word.begin + lengthDiff;
        const ne = word.end + lengthDiff;
        if (nb >= 0 && ne <= current.length && current.slice(nb, ne) === wordText) {
          return { ...word, begin: nb, end: ne, adjusted: true };
        }
      }
      // search for the word text near its old position
      let best = null;
      let bestScore = -1;
      let from = 0;
      while (true) {
        const idx = current.indexOf(wordText, from);
        if (idx === -1) break;
        const score = 1000 - Math.abs(idx - word.begin);
        if (score > bestScore) { bestScore = score; best = { begin: idx, end: idx + wordText.length }; }
        from = idx + 1;
      }
      if (best) return { ...word, begin: best.begin, end: best.end, adjusted: true };
      return { ...word, invalid: true };
    });
  }, [wordTokens, originalText, text]);

  if (!text) {
    return <div className="text-center py-8 text-gray-500"><p>No text to visualize</p></div>;
  }

  if (wordTokens.length === 0) {
    return (
      <div>
        <div
          ref={textContainerRef}
          className="p-4 bg-white rounded border border-gray-200 font-mono text-sm whitespace-pre-wrap select-text"
          onMouseUp={handleTextSelection}
        >
          {text}
        </div>
        <p className="mt-4 text-sm text-gray-500 text-center">
          No tokens yet. Click &quot;Whitespace Tokenize&quot; to create the hierarchy, or select text to create a word.
        </p>
      </div>
    );
  }

  const renderWordBadge = (word) => {
    const wordText = text.slice(word.begin, word.end);
    const display = word.begin === word.end ? '∅' : wordText;
    const isSentStart = sentenceInitialWordIds.has(word.id);
    const morphs = morphemesByWord.get(word.id) || [];
    const isMwt = morphs.length > 1;

    return (
      <span
        key={`w-${word.id}`}
        className={`relative inline-block px-1 py-0.5 border rounded mx-0.5 cursor-pointer transition-colors whitespace-pre ${isMwt ? 'bg-orange-100 border-orange-400 hover:bg-orange-200' : 'bg-blue-100 border-blue-300 hover:bg-blue-200'} ${isSentStart ? 'border-green-500 border-2' : ''}`}
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

        {hoveredWord && hoveredWord.id === word.id && !editingWord && !morphemeWord && (
          <div
            className="tv-overlay absolute top-full left-1/2 transform -translate-x-1/2 mt-1 z-10 bg-gray-800 text-white text-sm px-3 py-2 rounded shadow-lg whitespace-nowrap min-w-48"
            onMouseEnter={handleTooltipMouseEnter}
            onMouseLeave={handleTooltipMouseLeave}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-2">
              <div className="font-semibold">Word {String(word.id).slice(0, 8)}</div>
              <div className="text-gray-300">Range: [{word.begin}-{word.end}]</div>
              <div className="text-gray-300">Text: &quot;{wordText}&quot;</div>
              {isMwt && <div className="text-orange-300 mt-1">Morphemes: {morphs.map(m => formOf(m, word)).join(' + ')}</div>}
            </div>

            {onSentenceToggle && (
              <label
                className="flex items-center gap-2 mb-2 pb-2 border-b border-gray-600 cursor-pointer"
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
                  className="rounded border-gray-400 text-blue-600 focus:ring-blue-500"
                />
                <span className="text-gray-300 text-xs">Start of sentence</span>
              </label>
            )}

            <div className="flex gap-2">
              <button onClick={() => handleEditClick(word)} className="flex-1 bg-blue-600 hover:bg-blue-700 text-white text-xs px-2 py-1 rounded">Edit Range</button>
              {onSetWordMorphemes && (
                <button onClick={() => openMorphemeEditor(word)} className="flex-1 bg-orange-600 hover:bg-orange-700 text-white text-xs px-2 py-1 rounded">Morphemes</button>
              )}
              <button onClick={() => handleDeleteClick(word)} className="flex-1 bg-red-600 hover:bg-red-700 text-white text-xs px-2 py-1 rounded">Delete</button>
            </div>
          </div>
        )}

        {editingWord && editingWord.id === word.id && (
          <div
            className="tv-overlay absolute top-full left-1/2 transform -translate-x-1/2 mt-1 z-10 bg-white border border-gray-300 shadow-lg rounded-lg p-4 min-w-64"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3">
              <div className="font-semibold text-gray-900 mb-1">Edit Word Range</div>
              <div className="text-sm text-gray-600">Word: &quot;{text.slice(editingWord.begin, editingWord.end)}&quot;</div>
            </div>
            <div className="grid grid-cols-2 gap-3 mb-3">
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Begin</label>
                <input type="number" value={editBegin} onChange={(e) => setEditBegin(e.target.value)} className="w-full px-2 py-1 text-sm border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-blue-500" min="0" max={text.length} />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">End</label>
                <input type="number" value={editEnd} onChange={(e) => setEditEnd(e.target.value)} className="w-full px-2 py-1 text-sm border border-gray-300 rounded focus:outline-none focus:ring-1 focus:ring-blue-500" min="1" max={text.length} />
              </div>
            </div>
            <div className="flex gap-2">
              <button onClick={validateAndSave} className="flex-1 bg-green-600 hover:bg-green-700 text-white text-xs px-3 py-1 rounded">Save</button>
              <button onClick={handleEditCancel} className="flex-1 bg-gray-600 hover:bg-gray-700 text-white text-xs px-3 py-1 rounded">Cancel</button>
            </div>
          </div>
        )}

        {morphemeWord && morphemeWord.id === word.id && (
          <div
            className="tv-overlay absolute top-full left-1/2 transform -translate-x-1/2 mt-1 z-10 bg-white border border-gray-300 shadow-lg rounded-lg p-4 min-w-64 text-left"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="font-semibold text-gray-900 mb-1">Morphemes of &quot;{text.slice(word.begin, word.end)}&quot;</div>
            <div className="text-xs text-gray-500 mb-2">One form = an ordinary word; multiple = a multiword token.</div>
            <div className="space-y-1">
              {draftForms.map((form, i) => (
                <div key={i} className="flex items-center gap-1">
                  <input
                    type="text"
                    value={form}
                    onChange={(e) => setDraftForms(prev => prev.map((f, idx) => (idx === i ? e.target.value : f)))}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); saveMorphemes(); } else if (e.key === 'Escape') { e.preventDefault(); cancelMorphemes(); } }}
                    className="w-28 px-1 py-0.5 text-sm border border-gray-300 rounded font-mono"
                    autoFocus={i === draftForms.length - 1}
                  />
                  {draftForms.length > 1 && (
                    <button onClick={() => setDraftForms(prev => prev.filter((_, idx) => idx !== i))} className="text-red-500 text-xs" title="Remove morpheme">×</button>
                  )}
                </div>
              ))}
            </div>
            <div className="flex items-center gap-2 mt-2">
              <button onClick={() => setDraftForms(prev => [...prev, ''])} className="text-xs text-blue-600 hover:underline">+ morpheme</button>
              <div className="ml-auto flex gap-1">
                <button onClick={cancelMorphemes} className="text-xs px-2 py-0.5 rounded border border-gray-300">Cancel</button>
                <button onClick={saveMorphemes} className="text-xs px-2 py-0.5 rounded bg-blue-600 text-white">Save</button>
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
          els.push(<span key={`bt-${si}-${wi}`} className="text-gray-400">{text.slice(lastEnd, word.begin)}</span>);
        }
        els.push(renderWordBadge(word));
        lastEnd = Math.max(lastEnd, word.end);
      });
      return <div key={`s-${si}`} className="mb-2 relative">{els}</div>;
    });

    if (lastEnd < text.length) {
      blocks.push(<div key="trail" className="text-gray-400">{text.slice(lastEnd)}</div>);
    }
    if (invalid.length) {
      blocks.push(
        <div key="invalid" className="mt-2 text-xs text-amber-600">
          {invalid.length} word{invalid.length !== 1 ? 's' : ''} no longer match the edited text — save and re-tokenize to resync.
        </div>
      );
    }
    return blocks;
  };

  return (
    <div>
      {isTextDirty && (
        <div className="mb-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded p-2">
          Showing token positions relocated for your unsaved edits. Save the text to apply.
        </div>
      )}
      <div
        ref={textContainerRef}
        className="p-4 bg-white rounded border border-gray-200 font-mono text-sm leading-relaxed select-text"
        onMouseUp={handleTextSelection}
      >
        {renderText()}
      </div>
      <p className="mt-3 text-xs text-gray-500">
        Click a word to toggle a sentence boundary; hover for Edit Range / Morphemes / Delete; select text to create a word.
        With a word hovered, <code>s</code>/<code>S</code> move its start, <code>d</code>/<code>D</code> move its end.
      </p>
    </div>
  );
};
