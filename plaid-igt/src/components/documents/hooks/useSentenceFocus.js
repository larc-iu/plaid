import { useCallback, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { analyzeFocus, askSentenceFocus } from './focusHandoff.js';

// Landing on a sentence, from a link or from a citation.
//
// `?focusSentence=<id>&focusWord=<offset>` is the link half. The Analyze
// island reads its handoff (focusHandoff.js analyzeFocus) on mount and clears
// it, so the handoff is written DURING RENDER: the island is a child of the
// screen that calls this, and an effect runs after the child has already
// looked.
//
// An in-app click-through (a search hit) writes the same handoff a moment
// before it navigates, and its version carries `begin`, so the URL's version
// must not clobber it unless the URL names a word too.
//
// `focusHere` is the live half: a citation for a sentence of THIS document
// scrolls the grid instead of opening a second browser tab. It answers false
// wherever the grid is not mounted, because claiming a citation and scrolling
// nothing swallows the link. It goes to the island through AnalyzeIsland
// (askSentenceFocus), which hands it to the editor's focusSentence.

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
      const existing = analyzeFocus.read();
      const sameTarget =
        existing && existing.docId === documentId && existing.sentenceId === focusParam;
      const begin = Number.isInteger(focusWordParam) ? focusWordParam : null;
      if (!sameTarget || begin !== null) {
        analyzeFocus.write({ docId: documentId, sentenceId: focusParam, begin });
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
      askSentenceFocus({ documentId, focus, begin });
      return true;
    },
    [documentId, onEditor],
  );

  return focusHere;
}
