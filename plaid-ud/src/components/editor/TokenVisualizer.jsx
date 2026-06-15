import { useState, useRef, useEffect, useMemo } from 'react';
import {
  Alert, Text, Popover, Switch, Button, Group, Stack, TextInput, ActionIcon, Divider,
} from '@mantine/core';
import { IconTrash, IconPlus, IconX } from '@tabler/icons-react';
import { cpLength, cpSlice, cpIndexOf, utf16ToCp } from '@larc-iu/plaid-client';
import { containsToken } from '../../utils/udLayerUtils.js';
import { notifyError } from '../../utils/feedback.jsx';
import classes from './TokenVisualizer.module.css';

// Raw-text overlay editor for the three-layer token hierarchy. The editable
// surface is the TOKEN layer (rendered as badges over the document text); a
// token split into more than one word is a multi-word token (orange). Sentences
// are shown by a green border on each sentence's first token and toggled by
// clicking a token (split/merge server-side).
//
// Hovering a token opens its panel — token text + range, a sentence-start
// toggle, the word editor inline (split a token into words / a multi-word
// token), and a Delete. The panel is a Mantine Popover opened on hover but
// PINNED while you're editing inside it (so it never vanishes mid-edit); it
// dismisses on click-outside / Escape. Selecting text creates a token, and a
// live preview relocates tokens when the document text is edited after
// tokenization. There is deliberately NO token-resize affordance: a resize
// keeps token identity while changing what the token means, so annotations
// (incl. other apps' glosses on a shared substrate) silently drift onto
// different text. Boundary fixes are delete + re-create.
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
  // `openId` = the token whose panel is open (hover or pinned-while-editing).
  const [openId, setOpenId] = useState(null);
  const [draftForms, setDraftForms] = useState([]);
  const textContainerRef = useRef(null);
  const openTimer = useRef(null);
  const closeTimer = useRef(null);
  const panelRef = useRef(null); // the open panel's content, for focus checks

  const isTextDirty = Boolean(originalText) && text !== originalText;
  const contains = containsToken;
  const sortPos = (a, b) => (a.begin - b.begin) || (a.end - b.end) || ((a.precedence ?? 0) - (b.precedence ?? 0));

  // Words per token (server positions), and which tokens begin a sentence.
  const sortedMorphemes = useMemo(
    () => [...morphemeTokens].sort(sortPos),
    [morphemeTokens]
  );
  const morphemesByWord = useMemo(
    () => new Map(wordTokens.map(w => [w.id, sortedMorphemes.filter(m => contains(w, m))])),
    [wordTokens, sortedMorphemes]
  );
  const wordById = useMemo(() => new Map(wordTokens.map(w => [w.id, w])), [wordTokens]);
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
  // A token's current word forms — its words' Form-or-substring, or the token's
  // own surface for a 1:1 token. Seeds the editor and detects unsaved changes.
  const currentFormsOf = (word) => {
    const ms = morphemesByWord.get(word.id) || [];
    return ms.length ? ms.map(m => formOf(m, word)) : [cpSlice(text, word.begin, word.end)];
  };

  // --- hover open/close with pin-while-editing ---
  const OPEN_DELAY = 150;
  const CLOSE_DELAY = 200;
  const clearOpen = () => { if (openTimer.current) { clearTimeout(openTimer.current); openTimer.current = null; } };
  const clearClose = () => { if (closeTimer.current) { clearTimeout(closeTimer.current); closeTimer.current = null; } };
  // True while focus is inside the open panel — i.e. the user is editing.
  const isEditing = () => !!(panelRef.current && panelRef.current.contains(document.activeElement));
  const requestOpen = (id) => {
    clearClose();
    if (openId === id) return;
    if (isEditing()) return; // don't yank focus away from an in-progress edit
    clearOpen();
    openTimer.current = setTimeout(() => {
      openTimer.current = null;
      const word = wordById.get(id);
      if (word) setDraftForms(currentFormsOf(word)); // seed editor with current words
      setOpenId(id);
    }, OPEN_DELAY);
  };
  const requestClose = () => {
    clearOpen();
    clearClose();
    closeTimer.current = setTimeout(() => {
      closeTimer.current = null;
      if (isEditing()) return; // keep open while editing
      setOpenId(null);
    }, CLOSE_DELAY);
  };
  const keepOpen = () => { clearOpen(); clearClose(); };
  const closePanel = () => { clearOpen(); clearClose(); setOpenId(null); };
  useEffect(() => () => { clearOpen(); clearClose(); }, []);

  // Click a token (or its panel switch) to toggle whether it starts a sentence.
  const toggleSentence = async (word) => {
    if (isTextDirty || !onSentenceToggle) return;
    try {
      await onSentenceToggle(word.begin);
    } catch (e) {
      console.error('Failed to toggle sentence boundary:', e);
    }
  };

  const handleDeleteClick = async (word) => {
    closePanel();
    try {
      await onWordDelete?.(word.id);
    } catch (e) {
      console.error('Token delete failed:', e);
    }
  };

  // Apply the edited word forms (split into words / a multi-word token). No-op
  // when unchanged, so simply hovering + closing never rewrites the token.
  const saveWords = async (word) => {
    const forms = draftForms.map(f => f.trim()).filter(Boolean);
    const current = currentFormsOf(word).map(f => f.trim());
    closePanel();
    const changed = forms.length > 0 && JSON.stringify(forms) !== JSON.stringify(current);
    if (changed && onSetWordMorphemes) {
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
  const adjustedWords = useMemo(() => {
    const words = wordTokens;
    const original = originalText;
    const current = text;
    if (!original || original === current) return words;
    // Work in code points (token offsets are code points).
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
        onMouseEnter={isTextDirty ? undefined : () => requestOpen(word.id)}
        onMouseLeave={isTextDirty ? undefined : requestClose}
      >
        {display}
      </span>
    );

    // No panel while the text is dirty — the badges are relocated previews,
    // and editing is blocked until the text is saved.
    if (isTextDirty) return <span key={`w-${word.id}`}>{badge}</span>;

    return (
      <Popover
        key={`w-${word.id}`}
        opened={openId === word.id}
        onDismiss={closePanel}
        position="bottom"
        withArrow
        shadow="md"
        radius="md"
        withinPortal
      >
        <Popover.Target>{badge}</Popover.Target>
        <Popover.Dropdown p="sm" onMouseEnter={keepOpen} onMouseLeave={requestClose}>
          <Stack ref={panelRef} gap="xs" miw={244} maw={320}>
            <Group justify="space-between" gap="md" wrap="nowrap">
              <Text ff="monospace" fw={600} size="sm">{display}</Text>
              <Text size="xs" c="dimmed">[{word.begin}–{word.end}]</Text>
            </Group>

            {onSentenceToggle && (
              <Switch
                size="sm"
                checked={isSentStart}
                onChange={() => toggleSentence(word)}
                label="Start of sentence"
              />
            )}

            {onSetWordMorphemes && (
              <>
                <Divider my={2} />
                <Text size="xs" c="dimmed">Words{isMwt ? ' (multi-word token)' : ''}</Text>
                <Stack gap={6}>
                  {draftForms.map((form, i) => (
                    <Group key={i} gap="xs" wrap="nowrap">
                      <TextInput
                        size="xs"
                        value={form}
                        onChange={(e) => setDraftForms(prev => prev.map((f, idx) => (idx === i ? e.target.value : f)))}
                        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); saveWords(word); } }}
                        style={{ flex: 1 }}
                        styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)' } }}
                      />
                      {draftForms.length > 1 && (
                        <ActionIcon
                          variant="subtle"
                          color="gray"
                          size="sm"
                          onClick={() => setDraftForms(prev => prev.filter((_, idx) => idx !== i))}
                          aria-label="Remove word"
                        >
                          <IconX size={14} />
                        </ActionIcon>
                      )}
                    </Group>
                  ))}
                  <Button
                    variant="subtle"
                    size="compact-xs"
                    leftSection={<IconPlus size={14} />}
                    onClick={() => setDraftForms(prev => [...prev, ''])}
                    style={{ alignSelf: 'flex-start' }}
                  >
                    Add word
                  </Button>
                </Stack>
              </>
            )}

            <Divider my={2} />
            <Group justify="space-between" gap="xs">
              {onWordDelete ? (
                <Button
                  variant="subtle"
                  color="red"
                  size="compact-xs"
                  leftSection={<IconTrash size={14} />}
                  onClick={() => handleDeleteClick(word)}
                >
                  Delete
                </Button>
              ) : <span />}
              {onSetWordMorphemes && (
                <Button size="compact-xs" onClick={() => saveWords(word)}>Save</Button>
              )}
            </Group>
          </Stack>
        </Popover.Dropdown>
      </Popover>
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
