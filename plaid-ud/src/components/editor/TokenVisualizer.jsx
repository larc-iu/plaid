import { useState, useRef, useMemo } from 'react';
import {
  Alert, Text, HoverCard, Popover, Switch, Button, Group, Stack, TextInput, ActionIcon,
} from '@mantine/core';
import { IconPencil, IconTrash, IconPlus, IconX } from '@tabler/icons-react';
import { cpLength, cpSlice, cpIndexOf, utf16ToCp } from '@larc-iu/plaid-client';
import { containsToken } from '../../utils/udLayerUtils.js';
import { notifyError } from '../../utils/feedback.jsx';
import classes from './TokenVisualizer.module.css';

// Raw-text overlay editor for the three-layer token hierarchy. The editable
// surface is the TOKEN layer (rendered as badges over the document text); a
// token split into more than one word is a multi-word token (orange), edited via
// the word editor. Sentences are shown by a green border on each sentence's
// first token and toggled by clicking a token (split/merge server-side).
//
// Affordances: select text to create a token; hover a token for a panel with its
// words + a sentence-start toggle + edit/delete actions; and a live preview that
// relocates tokens when the document text is edited after tokenization. There is
// deliberately NO token-resize affordance: a resize keeps token identity while
// changing what the token means, so annotations (incl. other apps' glosses on a
// shared substrate) silently drift onto different text. Boundary fixes are
// delete + re-create, which routes through the foreign-annotation warning.
//
// UI is plain Mantine: the hover panel is a HoverCard; the token being edited
// swaps to a controlled Popover (pinned open) holding the word editor inline, so
// editing happens in place — no modal — and click-outside / Escape cancels. The
// only bespoke styling left is the inline token badges themselves.
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
  // The word editor (Modal) — `editorWord` is the token being split; null = closed.
  const [editorWord, setEditorWord] = useState(null);
  const [draftForms, setDraftForms] = useState([]);
  const textContainerRef = useRef(null);

  const isTextDirty = Boolean(originalText) && text !== originalText;
  const contains = containsToken;
  const sortPos = (a, b) => (a.begin - b.begin) || (a.end - b.end) || ((a.precedence ?? 0) - (b.precedence ?? 0));

  // Words per token (server positions), and which tokens begin a sentence.
  // Memoized to avoid recomputing the read model on every render.
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

  // Click a token (or its hover-panel switch) to toggle whether it starts a
  // sentence. No-op while the text is dirty or in read-only mode (no handler).
  const toggleSentence = async (word) => {
    if (isTextDirty || !onSentenceToggle) return;
    try {
      await onSentenceToggle(word.begin);
    } catch (e) {
      console.error('Failed to toggle sentence boundary:', e);
    }
  };

  const handleDeleteClick = async (word) => {
    try {
      await onWordDelete?.(word.id);
    } catch (e) {
      console.error('Token delete failed:', e);
    }
  };

  // --- word editor (multi-word tokens) ---
  const openWordEditor = (word) => {
    const ms = morphemesByWord.get(word.id) || [];
    setDraftForms(ms.length ? ms.map(m => formOf(m, word)) : [cpSlice(text, word.begin, word.end)]);
    setEditorWord(word);
  };
  const closeWordEditor = () => {
    setEditorWord(null);
    setDraftForms([]);
  };
  const saveWordEditor = async () => {
    const forms = draftForms.map(f => f.trim()).filter(Boolean);
    const word = editorWord;
    closeWordEditor();
    if (forms.length && onSetWordMorphemes) {
      try { await onSetWordMorphemes(word, forms); } catch (e) { console.error('Set words failed:', e); }
    }
  };

  // --- select text -> create token --- (offsets mapped via a TreeWalker that
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
      reportError('Cannot create token: selection overlaps an existing token');
      return;
    }
    onWordCreate(start, end);
    selection.removeAllRanges();
  };

  // --- live relocation of tokens when the text is edited after tokenization ---
  // Memoized: this is O(tokens × occurrences) and was running per render.
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
      // search for the token text near its old position
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
        <Text size="sm" c="dimmed" ta="center" mt="md">
          No tokens yet. Click &quot;Basic Tokenize&quot; to create the hierarchy, or select text to create a token.
        </Text>
      </div>
    );
  }

  const renderWordBadge = (word) => {
    const wordText = cpSlice(text, word.begin, word.end);
    const display = word.begin === word.end ? '∅' : wordText;
    const isSentStart = sentenceInitialWordIds.has(word.id);
    const morphs = morphemesByWord.get(word.id) || [];
    const isMwt = morphs.length > 1;

    const badge = (
      <span
        className={classes.badge}
        data-mwt={isMwt}
        data-sent-start={isSentStart}
        onClick={() => toggleSentence(word)}
      >
        {display}
      </span>
    );

    // No hover panel while the text is dirty — the badges are relocated previews,
    // and editing is blocked until the text is saved.
    if (isTextDirty) return <span key={`w-${word.id}`}>{badge}</span>;

    // The token being edited: a controlled Popover (pinned open) with the word
    // editor inline. Click-outside / Escape cancels (onDismiss); Save/Cancel
    // close it explicitly. Rendered INSTEAD of the HoverCard (never nested).
    if (editorWord?.id === word.id) {
      return (
        <Popover
          key={`w-${word.id}`}
          opened
          onDismiss={closeWordEditor}
          position="bottom"
          withArrow
          shadow="md"
          radius="md"
          trapFocus
          withinPortal
        >
          <Popover.Target>{badge}</Popover.Target>
          <Popover.Dropdown p="sm">
            <Stack gap="sm" miw={244}>
              <Text size="sm" fw={600}>Words of “{wordText}”</Text>
              <Text size="xs" c="dimmed">One word = an ordinary token; multiple = a multi-word token.</Text>
              <Stack gap="xs">
                {draftForms.map((form, i) => (
                  <Group key={i} gap="xs" wrap="nowrap">
                    <TextInput
                      size="xs"
                      value={form}
                      onChange={(e) => setDraftForms(prev => prev.map((f, idx) => (idx === i ? e.target.value : f)))}
                      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); saveWordEditor(); } }}
                      style={{ flex: 1 }}
                      data-autofocus={i === draftForms.length - 1 || undefined}
                      autoFocus={i === draftForms.length - 1}
                      styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)' } }}
                    />
                    {draftForms.length > 1 && (
                      <ActionIcon
                        variant="subtle"
                        color="red"
                        onClick={() => setDraftForms(prev => prev.filter((_, idx) => idx !== i))}
                        aria-label="Remove word"
                      >
                        <IconX size={16} />
                      </ActionIcon>
                    )}
                  </Group>
                ))}
              </Stack>
              <Group justify="space-between">
                <Button
                  variant="subtle"
                  size="compact-sm"
                  leftSection={<IconPlus size={14} />}
                  onClick={() => setDraftForms(prev => [...prev, ''])}
                >
                  Add word
                </Button>
                <Group gap="xs">
                  <Button variant="default" size="xs" onClick={closeWordEditor}>Cancel</Button>
                  <Button size="xs" onClick={saveWordEditor}>Save</Button>
                </Group>
              </Group>
            </Stack>
          </Popover.Dropdown>
        </Popover>
      );
    }

    return (
      <HoverCard
        key={`w-${word.id}`}
        openDelay={200}
        closeDelay={150}
        position="bottom"
        withArrow
        shadow="md"
        radius="md"
        withinPortal
      >
        <HoverCard.Target>{badge}</HoverCard.Target>
        <HoverCard.Dropdown p="sm">
          <Stack gap="xs" miw={208} maw={300}>
            <Group justify="space-between" gap="md" wrap="nowrap">
              <Text ff="monospace" fw={600} size="sm">{display}</Text>
              <Text size="xs" c="dimmed">[{word.begin}–{word.end}]</Text>
            </Group>

            {isMwt && (
              <Text size="xs" c="orange.7">
                {morphs.length} words: {morphs.map(m => formOf(m, word)).join(' + ')}
              </Text>
            )}

            {onSentenceToggle && (
              <Switch
                size="sm"
                checked={isSentStart}
                onChange={() => toggleSentence(word)}
                label="Start of sentence"
              />
            )}

            {onSetWordMorphemes && (
              <Button
                fullWidth
                variant="light"
                leftSection={<IconPencil size={16} />}
                onClick={() => openWordEditor(word)}
              >
                Edit words
              </Button>
            )}
            {onWordDelete && (
              <Button
                fullWidth
                variant="light"
                color="red"
                leftSection={<IconTrash size={16} />}
                onClick={() => handleDeleteClick(word)}
              >
                Delete
              </Button>
            )}
          </Stack>
        </HoverCard.Dropdown>
      </HoverCard>
    );
  };

  const renderText = () => {
    const adjusted = adjustedWords;
    const valid = adjusted.filter(w => !w.invalid).sort((a, b) => a.begin - b.begin);
    const invalid = adjusted.filter(w => w.invalid);

    // Group tokens into sentences (a token that begins a sentence starts a block).
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
        <Text key="invalid" size="xs" c="orange.6" mt="xs">
          {invalid.length} token{invalid.length !== 1 ? 's' : ''} no longer match the edited text — save and re-tokenize to resync.
        </Text>
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
      <Text size="xs" c="dimmed" mt="sm">
        Click a token to toggle its sentence boundary; hover a token to edit its words or delete it;
        select text to create a token.
      </Text>
    </div>
  );
};
