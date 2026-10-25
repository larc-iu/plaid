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
// Nothing here catches. Storage can throw (a denied site, a private window),
// and each caller decides what that costs it.
const handoff = (key) => ({
  write: (req) => sessionStorage.setItem(key, JSON.stringify(req)),
  read: () => JSON.parse(sessionStorage.getItem(key) || 'null'),
  clear: () => sessionStorage.removeItem(key),
});

export const analyzeFocus = handoff('igt:focus-sentence');
export const tokenizeFocus = handoff('igt:focus-tokenize');

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
