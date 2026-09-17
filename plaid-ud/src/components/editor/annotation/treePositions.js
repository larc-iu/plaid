// How a relation endpoint finds its word on screen. Relations point at lemma
// spans, and a word with no lemma span yet stands in for its own, so a measured
// position answers to either id. Shared by the tree above the words and the
// band of enhanced edges below them, which must agree on it.

export const getEffectiveSpanId = (position) => {
  if (!position) return null;
  return position.lemmaSpanId || position.token?.id || null;
};

export const positionMatchesSpanId = (position, spanId) => {
  if (!position || !spanId) return false;
  if (position.lemmaSpanId && position.lemmaSpanId === spanId) return true;
  return position.token?.id === spanId;
};
