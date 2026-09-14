import { useEffect, useRef, useState } from 'react';

// `?sent=<sentenceTokenId>`: turn to the page that sentence is on, scroll to it,
// and flash it once. The search page links here, and so does a citation in the
// assistant panel.
//
// TWO passes, deliberately. A row on another page is not in the DOM at all, so
// the first pass only turns the page and lets the effect run again against the
// page that has now rendered. Only the pass that scrolls marks the request
// answered, which is why turning the page returns early without recording it.
//
// `focusNonce` is what lets the assistant ask for the same sentence twice: a
// repeat click leaves the query string exactly as it was, and without a nonce
// the guard below would swallow it.
//
// Returns the id of the sentence to flash, or null.

const FLASH_MS = 2000;

export function useSentenceDeepLink({
  sentParam,
  focusNonce,
  ready,
  indexById,
  pageSize,
  page,
  setPage,
}) {
  const [flashSentId, setFlashSentId] = useState(null);
  const answeredRef = useRef(null);

  useEffect(() => {
    if (!ready || !sentParam || !indexById.size) return;
    const asked = `${sentParam}:${focusNonce}`;
    if (answeredRef.current === asked) return;
    const index = indexById.get(String(sentParam));
    if (index == null) return;
    const target = Math.floor(index / pageSize);
    if (target !== page) {
      setPage(target);
      return;
    }
    answeredRef.current = asked;
    let flashTimer = null;
    const raf = requestAnimationFrame(() => {
      const selector = `[data-sentence-row="${CSS.escape(String(sentParam))}"]`;
      document.querySelector(selector)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setFlashSentId(String(sentParam));
      flashTimer = setTimeout(() => setFlashSentId(null), FLASH_MS);
    });
    return () => {
      cancelAnimationFrame(raf);
      if (flashTimer) clearTimeout(flashTimer);
    };
  }, [ready, sentParam, focusNonce, indexById, pageSize, page, setPage]);

  return flashSentId;
}
