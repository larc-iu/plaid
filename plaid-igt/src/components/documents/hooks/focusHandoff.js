// Where a tab opens next, handed over before it mounts.
//
// A search hit, a validation row, a bulk-edit row, a ?focusSentence= link and a
// word pressed on the Tokenize tab each write `analyzeFocus`, and the Analyze
// island reads it on mount and clears it once it has landed. Alt+click on a
// word in the grid writes `tokenizeFocus`, which the Tokenize tab reads the
// same way. Session storage, so the request survives the navigation that
// mounts its reader and goes with the browser tab.
//
// A request is `{ docId, sentenceId, begin, level }`: `begin` is a word's start
// in the text or null, and `level: 'word'` asks the grid for the word's own row
// (from Tokenize) rather than its morphemes (from a search).
//
// The Analyze and Baseline tabs hand each other the sentence the reader was
// on. Leaving the grid writes `baselineFocus`, `{ docId, sentenceId, at }`
// with `at` the sentence's start, and the Baseline tab lands on it. The
// Baseline tab writes `analyzeFocus` with `sentenceId: null` and `at` the
// caret, and the grid opens on the sentence holding it. Either reader takes
// the sentence nearest `at` when the one named is gone. `at` counts code
// points, as every offset in the text does.
//
// Nothing here catches. Storage can throw (a denied site, a private window),
// and each caller decides what that costs it.
const handoff = (key) => ({
  write: (req) => sessionStorage.setItem(key, JSON.stringify(req)),
  read: () => JSON.parse(sessionStorage.getItem(key) || 'null'),
  clear: () => sessionStorage.removeItem(key),
});

export const analyzeFocus = handoff('igt:focus-sentence');
export const tokenizeFocus = handoff('igt:focus-tokenize');
export const baselineFocus = handoff('igt:focus-baseline');

// A handoff is for the next tab only. Each of the three tabs opens with this:
// it reads its own request and drops every other, so a request left for a tab
// the reader went past never lands later (Analyze, Tokenize, Baseline lands
// Baseline on nothing). Its own stays until its landing is done.
const ALL = [analyzeFocus, tokenizeFocus, baselineFocus];
export function openTab(own) {
  const req = own.read();
  for (const h of ALL) if (h !== own) h.clear();
  return req;
}

// The sentence holding code point `at`, else the one closest to it, else null
// for a document with no sentences. A caret just after a sentence's last
// character is in that sentence.
export function sentenceNear(sentences, at) {
  let best = null;
  let gap = Infinity;
  for (const s of sentences || []) {
    if (s.begin <= at && at < s.end) return s;
    const d = at < s.begin ? s.begin - at : at - s.end;
    if (d < gap) {
      best = s;
      gap = d;
    }
  }
  return best;
}

// The live half, for a grid already on screen: an assistant citation into
// this document asks the mounted island to land on a sentence
// (`{ documentId, focus, begin }`, focus being the sentence id). AnalyzeIsland
// listens while its island is up, and the island ignores another document's.
const sentenceListeners = new Set();

export const onSentenceFocus = (fn) => {
  sentenceListeners.add(fn);
  return () => sentenceListeners.delete(fn);
};

export const askSentenceFocus = (req) => {
  for (const fn of sentenceListeners) fn(req);
};
