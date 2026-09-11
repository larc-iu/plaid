import { useCallback, useRef, useEffect } from 'react';
import { isMachine } from '@larc-iu/plaid-client';
import {
  adjacentWord,
  findWord,
  markedFields,
  nextReviewWord,
  wordHasMaterial,
} from '../../../domain/reviewTargets.js';

// The review gestures, owned at document level because every one of them can
// cross a sentence boundary and a SentenceRow only knows its own sentence:
//
//   Ctrl/Cmd+Enter      accept this word's proposal, then move to the next word
//   Ctrl/Cmd+Backspace  discard it, then move to the next word
//   Ctrl/Cmd+Shift+↑/↓  jump to the previous / next word that still needs a look
//
// Every cell's input carries the id `${tokenId}-${field}`, so the gesture reads
// its target off the event rather than off document.activeElement: the cell's
// own Enter handler may already have blurred by the time this bubbling handler
// runs.

// A beat between the write and the hop, so the mark going away is visible
// before the browser scrolls the next cell into view. Anything the reader does
// during it flushes it: holding the chord down must not stack delays, and a
// character typed in the window belongs to the cell being moved to.
const ADVANCE_BEAT_MS = 200;

// Rows are virtualized: a sentence nobody has scrolled to renders a
// placeholder, so a hop into one has to scroll first and then wait for the row
// to mount. Bounded, and silent when it runs out — a sweep that gives up
// quietly is better than one that throws.
const MOUNT_WAIT_MS = 1500;

export function useReviewGestures({ sentences, doc, readOnly, visibleFields }) {
  const beatRef = useRef(null);
  const rafRef = useRef(null);

  const cancelPending = useCallback(() => {
    if (beatRef.current) {
      clearTimeout(beatRef.current.timer);
      const { run } = beatRef.current;
      beatRef.current = null;
      run();
    }
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  useEffect(
    () => () => {
      if (beatRef.current) clearTimeout(beatRef.current.timer);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    },
    [],
  );

  // Focus `${tokenId}-${field}`, scrolling its sentence into view and waiting
  // for the row to mount when it is still a placeholder.
  const focusCell = useCallback((sentenceId, tokenId, field) => {
    const deadline = Date.now() + MOUNT_WAIT_MS;
    const attempt = () => {
      rafRef.current = null;
      const el = document.getElementById(`${tokenId}-${field}`);
      if (el) {
        el.focus();
        try {
          el.select?.();
        } catch {
          /* not a text input */
        }
        return;
      }
      if (Date.now() > deadline) return;
      rafRef.current = requestAnimationFrame(attempt);
    };
    document
      .querySelector(`[data-sentence-row="${CSS.escape(String(sentenceId))}"]`)
      ?.scrollIntoView({ block: 'center' });
    attempt();
  }, []);

  // Which cell of `target` to land on: the first visible field that earned the
  // stop, else the row the caret is already in, else the first visible row.
  const landingField = useCallback(
    (tokenId, fromField) => {
      const visible = ['lemma', 'xpos', 'upos', 'feats'].filter((f) => visibleFields?.[f]);
      if (!visible.length) return null;
      const entry = findWord(sentences, tokenId);
      const marked = markedFields(entry, doc.writer.reviewable).filter((f) => visible.includes(f));
      if (marked.length) return marked[0];
      return visible.includes(fromField) ? fromField : visible[0];
    },
    [sentences, doc, visibleFields],
  );

  const hopToNextWord = useCallback(
    (tokenId, fromField) => {
      const next = adjacentWord(sentences, tokenId, 'next');
      if (!next) return;
      const field = landingField(next.tokenId, fromField);
      if (field) focusCell(next.sentenceId, next.tokenId, field);
    },
    [sentences, landingField, focusCell],
  );

  const afterABeat = useCallback(
    (run) => {
      cancelPending();
      beatRef.current = {
        run,
        timer: setTimeout(() => {
          beatRef.current = null;
          run();
        }, ADVANCE_BEAT_MS),
      };
    },
    [cancelPending],
  );

  const onKeyDown = useCallback(
    (e) => {
      if (readOnly || !doc) return;
      const ctrl = e.ctrlKey || e.metaKey;
      if (!ctrl) {
        // Any other keystroke during the beat flushes it, so a character never
        // lands in the cell being left.
        if (beatRef.current) cancelPending();
        return;
      }

      // Ctrl/Cmd+Shift+↑/↓: the sweep. Reads the caret's word off the event
      // target, so it works from any cell.
      if (e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        const m = /^(.*)-(lemma|xpos|upos|feats)$/.exec(e.target?.id || '');
        e.preventDefault();
        cancelPending();
        const dir = e.key === 'ArrowDown' ? 'next' : 'previous';
        const stop = nextReviewWord(sentences, doc.writer.reviewable, m?.[1] ?? null, dir);
        if (!stop) return;
        const field = landingField(stop.tokenId, m?.[2]);
        if (field) focusCell(stop.sentenceId, stop.tokenId, field);
        return;
      }

      const m = /^(.*)-(lemma|xpos|upos|feats)$/.exec(e.target?.id || '');
      if (!m) return;
      const [, tokenId, field] = m;

      if (e.key === 'Enter') {
        e.preventDefault();
        cancelPending();
        // Nothing to accept: hold position. A hop with no visible change reads
        // exactly like a confirmation that never happened.
        if (!wordHasMaterial(sentences, tokenId, doc.writer.reviewable)) return;
        doc.confirmTokens([tokenId]);
        afterABeat(() => hopToNextWord(tokenId, field));
        return;
      }

      if (e.key === 'Backspace' || e.key === 'Delete') {
        // Claimed only over an UNTOUCHED input: with text typed and not yet
        // saved this chord is the browser's own delete-a-word, and taking it
        // would drop what was typed. `data-orig` is the cell's saved value.
        const el = e.target;
        if (el.value !== (el.dataset.orig ?? '')) return;
        e.preventDefault();
        cancelPending();
        // Discard takes MACHINE material only, whoever is looking, so the
        // "anything to do" test is that and not the writer's review scope.
        if (!wordHasMaterial(sentences, tokenId, isMachine)) return;
        doc.discardTokens([tokenId]);
        afterABeat(() => hopToNextWord(tokenId, field));
      }
    },
    [readOnly, doc, sentences, landingField, focusCell, hopToNextWord, afterABeat, cancelPending],
  );

  return onKeyDown;
}
