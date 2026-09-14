import { useCallback, useRef } from 'react';

// Landing on a sentence, from a link or from a citation.
//
// `?focusSentence=<id>&focusWord=<offset>` is the link half. The Analyze
// island reads a handoff key on mount and clears it, so the key is written
// DURING RENDER: the island's shell is a child of this screen, and an effect
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

export function useSentenceFocus({ documentId, focusParam, focusWordParam, activeTab }) {
  const seededRef = useRef(false);
  if (!seededRef.current && focusParam) {
    seededRef.current = true;
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
      if (cited !== documentId || !focus || activeTab !== 'analyze') return false;
      window.dispatchEvent(
        new CustomEvent(FOCUS_SENTENCE, { detail: { documentId, focus, begin } }),
      );
      return true;
    },
    [documentId, activeTab],
  );

  return focusHere;
}
