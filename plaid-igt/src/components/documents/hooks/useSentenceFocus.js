import { useCallback, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';

// Landing on a sentence, from a link or from a citation.
//
// `?focusSentence=<id>&focusWord=<offset>` is the link half. The Analyze
// island reads a handoff key on mount and clears it, so the key is written
// DURING RENDER: the island is a child of the screen that calls this, and an effect
// runs after the child has already looked.
//
// An in-app click-through (a search hit) writes the same key a moment before it
// navigates, and its version carries `begin`, so the URL's version must not
// clobber it unless the URL names a word too.
//
// `focusHere` is the live half: a citation for a sentence of THIS document
// scrolls the grid instead of opening a second browser tab. It answers false
// wherever the grid is not mounted, because claiming a citation and scrolling
// nothing swallows the link.
//
// The storage key and the window event share a name on purpose: the island
// reads one and listens for the other, and both mean the same request.
const FOCUS_SENTENCE = 'igt:focus-sentence';

export function useSentenceFocus({ documentId, onEditor }) {
  const [searchParams] = useSearchParams();
  const focusParam = searchParams.get('focusSentence');
  // A character offset in the text: an assistant citation names the word it
  // cites, so the link lands on the word and not just the sentence.
  const focusWordParam = Number.parseInt(searchParams.get('focusWord') ?? '', 10);
  // The sentence last handed over: a later render does not re-arm a request
  // the island consumed, and a link to another sentence (the Comments tab's
  // jumps, with this screen kept mounted) is handed over again.
  const seededRef = useRef(null);
  if (focusParam && seededRef.current !== focusParam) {
    seededRef.current = focusParam;
    try {
      const existing = JSON.parse(sessionStorage.getItem(FOCUS_SENTENCE) || 'null');
      const sameTarget =
        existing && existing.docId === documentId && existing.sentenceId === focusParam;
      const begin = Number.isInteger(focusWordParam) ? focusWordParam : null;
      if (!sameTarget || begin !== null) {
        sessionStorage.setItem(
          FOCUS_SENTENCE,
          JSON.stringify({ docId: documentId, sentenceId: focusParam, begin }),
        );
      }
    } catch {
      /* noop */
    }
  }

  const focusHere = useCallback(
    ({ documentId: cited, focus, begin }) => {
      // The panel is open on every tab and the grid only listens on one of
      // them.
      if (cited !== documentId || !focus || !onEditor) return false;
      window.dispatchEvent(
        new CustomEvent(FOCUS_SENTENCE, { detail: { documentId, focus, begin } }),
      );
      return true;
    },
    [documentId, onEditor],
  );

  return focusHere;
}
