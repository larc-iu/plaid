import { isTokenIgnored, readIgnoredTokens } from '@/domain/igtConfig';

// The words the long-document notice weighs: a token the ignored-tokens rule
// excludes is text, not a word.
export const igtWordCount = (doc) => {
  const layer = doc?.layerInfo?.primaryTokenLayer;
  if (!layer?.tokens) return undefined;
  const cfg = readIgnoredTokens(layer.config);
  const body = [...(doc.body || '')];
  return layer.tokens.filter((t) => !isTokenIgnored(body.slice(t.begin, t.end).join(''), cfg))
    .length;
};
