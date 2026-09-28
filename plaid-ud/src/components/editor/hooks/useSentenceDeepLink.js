import { useEffect, useRef, useState } from 'react';

// `?sent=<sentenceTokenId>`, or the sentence's number (`?sent=12`, `?sent=s12`,
// counted from 1 as the rows are, the way plaid-umr reads it): turn to the page
// that sentence is on, scroll to it, and flash it once. The search page links here, and so does a citation in the
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

// The number a `?sent=` value names, or null when it is not one.
export const sentenceNumberOf = (param) => {
  const m = /^s?(\d+)$/i.exec(String(param ?? '').trim());
  const n = m ? Number(m[1]) : 0;
  return n >= 1 ? n : null;
};

// The id of the sentence a `?sent=` value names: an id the document has, else
// the sentence at that number. `indexById` maps each id to its place.
export const resolveSentenceParam = (param, indexById) => {
  if (param == null || param === '') return null;
  if (indexById.has(String(param))) return String(param);
  const n = sentenceNumberOf(param);
  if (n == null) return null;
  for (const [id, index] of indexById) if (index === n - 1) return id;
  return null;
};

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
    const sentId = resolveSentenceParam(sentParam, indexById);
    if (sentId == null) return;
    const index = indexById.get(sentId);
    const target = Math.floor(index / pageSize);
    if (target !== page) {
      // The link is the history entry already: its page is written in place.
      setPage(target, { replace: true });
      return;
    }
    answeredRef.current = asked;
    let flashTimer = null;
    const raf = requestAnimationFrame(() => {
      const selector = `[data-sentence-row="${CSS.escape(sentId)}"]`;
      document.querySelector(selector)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setFlashSentId(sentId);
      flashTimer = setTimeout(() => setFlashSentId(null), FLASH_MS);
    });
    return () => {
      cancelAnimationFrame(raf);
      if (flashTimer) clearTimeout(flashTimer);
    };
  }, [ready, sentParam, focusNonce, indexById, pageSize, page, setPage]);

  return flashSentId;
}
