// Click-through target for a hit: the document's Analyze tab focused on the
// hit sentence. The tab + sentence ride in the URL so the result is a real,
// shareable link (and a middle-click opens it in a new tab); the caret offset
// goes through sessionStorage via `rememberCaret`, since landing on the exact
// WORD is a detail of a click here, not something a shared link reproduces.
export const hitTo = (projectId, docId, sentenceId) =>
  `/projects/${projectId}/documents/${docId}?tab=analyze&focusSentence=${encodeURIComponent(sentenceId)}`;

export const rememberCaret = (docId, sentenceId, begin = null) => {
  sessionStorage.setItem('igt:focus-sentence', JSON.stringify({ docId, sentenceId, begin }));
};
