// Pure derivation functions. Take a raw plaid-client document + its layer
// info + project + vocabularies; return the render-friendly view used by the
// editor. Cached in IgtDocument by `_version`.
//
// This is the documentParser.js logic relocated and trimmed to be a pure fn
// over arguments instead of constructing its own state. Note the lookup maps
// (tokenLookup, sentenceLookup, tokenPositionMaps, sentenceIndexLookup,
// findSentenceForToken) are produced together so they stay in sync with
// `sentences`.

import { provState, PROV_STATES } from '@larc-iu/plaid-client';
import { readDocumentMetadata, readOrthographies } from './igtConfig.js';

// Local copy of plaid-client-js's cpSlicer (spread the body into code points
// ONCE; each slice is then O(slice length) — cpSlice re-spreads the whole
// string per call, which is quadratic across thousands of tokens). Inlined
// rather than imported so a stale vite prebundle of the linked client package
// can't break the editor (the export exists there too for other consumers).
const cpSlicer = (s) => {
  const chars = [...(s ?? '')];
  return (begin, end) => chars.slice(begin, end).join('');
};

export function deriveDocumentData(raw, layerInfo, project) {
  const configuredMetadata = {};
  const fields = readDocumentMetadata(project?.config);
  if (Array.isArray(fields) && raw?.metadata) {
    fields.forEach(field => {
      if (field?.name && Object.prototype.hasOwnProperty.call(raw.metadata, field.name)) {
        configuredMetadata[field.name] = raw.metadata[field.name];
      }
    });
  }
  return {
    id: raw?.id,
    name: raw?.name,
    project: raw?.project,
    version: raw?.version,
    mediaUrl: raw?.mediaUrl,
    text: layerInfo.primaryTextLayer?.text,
    metadata: configuredMetadata
  };
}

export function deriveAlignmentTokens(layerInfo) {
  const layer = layerInfo.alignmentTokenLayer;
  if (!layer || !Array.isArray(layer.tokens)) return [];
  return [...layer.tokens]
    .map(t => ({ ...t, annotations: {} }))
    .sort((a, b) => a.begin - b.begin);
}

// Build the sentence > token > morpheme view, plus lookup maps and the
// binary-search findSentenceForToken function. Returns one bundle so all
// derivations share one traversal.
export function deriveSentences(raw, layerInfo, vocabularies) {
  const primaryTextLayer = layerInfo.primaryTextLayer;
  const primaryTokenLayer = layerInfo.primaryTokenLayer;
  const sentenceTokenLayer = layerInfo.sentenceTokenLayer;
  const morphemeTokenLayer = layerInfo.morphemeTokenLayer;
  const spanLayers = layerInfo.spanLayers;
  const body = primaryTextLayer?.text?.body ?? '';
  // One prebuilt code-point slicer for the whole pass: cpSlice spreads the
  // entire body per call, which is quadratic across thousands of tokens.
  const sliceBody = cpSlicer(body);

  // Vocab links live on the project's vocab table (loaded separately by
  // IgtDocument.load as `_vocabularies` and patched by the vocab mutations),
  // NOT embedded on the document's token layers. One combined map keyed by
  // token id serves both word tokens and morphemes (a link may target either).
  const vocabLinksByToken = collectSingleTokenVocabLinks(vocabularies);

  const sortedTokens = (primaryTokenLayer?.tokens || [])
    .map(t => ({
      id: t.id,
      text: t.text,
      begin: t.begin,
      end: t.end,
      content: sliceBody(t.begin, t.end),
      metadata: t.metadata || {},
      annotations: {},
      orthographies: collectOrthographies(t, primaryTokenLayer),
      vocabItem: vocabLinksByToken[t.id] || null,
      morphemes: []
    }))
    .sort((a, b) => a.begin - b.begin);

  // Per-layer tokenId -> span maps, built in ONE pass over each layer's spans
  // (first span per token wins, matching the old `.find` order). Annotation
  // collection is then O(layers) per item; the previous scan-all-spans-per-item
  // approach was quadratic and took seconds on real (FLEx-imported) documents.
  const buildSpanMaps = (layers) => (layers || []).map(sl => {
    const map = new Map();
    for (const s of sl.spans || []) {
      if (!Array.isArray(s.tokens)) continue;
      for (const tid of s.tokens) if (!map.has(tid)) map.set(tid, s);
    }
    return { name: sl.name, map };
  });
  const wordSpanMaps = buildSpanMaps(spanLayers.word);
  const morphSpanMaps = buildSpanMaps(spanLayers.morpheme);
  const sentSpanMaps = buildSpanMaps(spanLayers.sentence);
  const annotationsFor = (id, layerMaps) => {
    const out = {};
    for (const { name, map } of layerMaps) out[name] = map.get(id) ?? null;
    return out;
  };

  // Morphemes grouped by parent word via same-extent (begin/end) match.
  const morphemesByWord = new Map();
  if (morphemeTokenLayer) {
    const wordKey = new Map();
    sortedTokens.forEach(w => wordKey.set(`${w.begin}-${w.end}`, w));
    (morphemeTokenLayer.tokens || []).forEach(m => {
      const parent = wordKey.get(`${m.begin}-${m.end}`);
      if (!parent) return;
      const entry = {
        id: m.id,
        text: m.text,
        begin: m.begin,
        end: m.end,
        precedence: m.precedence ?? 1,
        content: sliceBody(m.begin, m.end),
        metadata: m.metadata || {},
        annotations: annotationsFor(m.id, morphSpanMaps),
        vocabItem: vocabLinksByToken[m.id] || null
      };
      if (!morphemesByWord.has(parent.id)) morphemesByWord.set(parent.id, []);
      morphemesByWord.get(parent.id).push(entry);
    });
    morphemesByWord.forEach(arr => arr.sort((a, b) => a.precedence - b.precedence));
  }

  // Sentence bucketing.
  const sentenceTokens = [...(sentenceTokenLayer?.tokens || [])]
    .map(s => ({
      id: s.id,
      text: s.text || '',
      begin: s.begin,
      end: s.end,
      sentenceToken: s,
      annotations: {}
    }))
    .sort((a, b) => a.begin - b.begin);

  // Single sweep over the begin-sorted tokens (sentences are a begin-sorted
  // partition), instead of filtering the whole token list per sentence.
  let ti = 0;
  const enrichedSentences = sentenceTokens.map(sentence => {
    while (ti < sortedTokens.length && sortedTokens[ti].begin < sentence.begin) ti++;
    const tokensInSentence = [];
    while (ti < sortedTokens.length && sortedTokens[ti].begin < sentence.end) {
      const t = sortedTokens[ti];
      if (t.begin >= sentence.begin && t.end <= sentence.end) {
        tokensInSentence.push({
          ...t,
          annotations: annotationsFor(t.id, wordSpanMaps),
          morphemes: morphemesByWord.get(t.id) || []
        });
      }
      ti++;
    }
    const sentenceAnnotations = annotationsFor(sentence.id, sentSpanMaps);
    const pieces = computePieces(sentence, tokensInSentence, sliceBody);
    return {
      ...sentence,
      annotations: sentenceAnnotations,
      tokens: tokensInSentence,
      pieces,
    };
  });

  const sortedSentences = [...enrichedSentences].sort((a, b) => a.begin - b.begin);

  const tokenLookup = new Map();
  const sentenceLookup = new Map();
  const tokenPositionMaps = new Map();
  const sentenceIndexLookup = new Map();
  enrichedSentences.forEach((sentence, sIdx) => {
    sentenceLookup.set(sentence.id, sentence);
    sentenceIndexLookup.set(sentence.id, sIdx);
    const posMap = new Map();
    (sentence.tokens || []).forEach((tok, tIdx) => {
      tokenLookup.set(tok.id, tok);
      posMap.set(tok.id, tIdx);
    });
    tokenPositionMaps.set(sentence.id, posMap);
  });

  const findSentenceForToken = makeBinarySearchSentenceLookup(sortedSentences);

  return {
    sentences: enrichedSentences,
    sortedSentences,
    tokenLookup,
    sentenceLookup,
    tokenPositionMaps,
    sentenceIndexLookup,
    findSentenceForToken
  };
}

function collectOrthographies(token, primaryTokenLayer) {
  const out = {};
  const configs = readOrthographies(primaryTokenLayer?.config) || [];
  configs.forEach(c => {
    const key = `orthog:${c.name}`;
    out[c.name] = token.metadata?.[key] || '';
  });
  return out;
}

function computePieces(sentence, tokens, sliceBody) {
  const pieces = [];
  const sorted = [...tokens].sort((a, b) => a.begin - b.begin);
  let lastEnd = sentence.begin;
  for (const t of sorted) {
    if (t.begin > lastEnd) {
      pieces.push({
        type: 'gap',
        content: sliceBody(lastEnd, t.begin),
        isToken: false,
        begin: lastEnd,
        end: t.begin
      });
    }
    pieces.push({ type: 'token', ...t, isToken: true });
    lastEnd = t.end;
  }
  if (lastEnd < sentence.end) {
    pieces.push({
      type: 'gap',
      content: sliceBody(lastEnd, sentence.end),
      isToken: false,
      begin: lastEnd,
      end: sentence.end
    });
  }
  return pieces;
}

function makeBinarySearchSentenceLookup(sortedSentences) {
  return function findSentenceForToken(token) {
    if (!token || typeof token.begin !== 'number' || typeof token.end !== 'number') return null;
    let lo = 0, hi = sortedSentences.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const s = sortedSentences[mid];
      if (token.begin >= s.begin && token.end <= s.end) return s;
      if (token.begin < s.begin) hi = mid - 1;
      else lo = mid + 1;
    }
    return null;
  };
}

// Collapse vocab.vocabLinks → { [tokenId]: vocabItemSummary } for vocab links
// that point at a single token. Multi-token links are ignored here (they're
// not surfaced on the token view); the parser used to warn about and randomly
// keep one of duplicate single-token links, but we drop that for now — the
// data shouldn't get into that state and the warning had no follow-through
// without a long-lived client to schedule the cleanup against.
function collectSingleTokenVocabLinks(vocabularies) {
  const out = {};
  Object.values(vocabularies || {}).forEach(vocab => {
    (vocab.vocabLinks || []).forEach(link => {
      if (!Array.isArray(link.tokens) || link.tokens.length !== 1 || !link.vocabItem) return;
      const tokenId = link.tokens[0];
      const linkMeta = link.metadata || {};
      out[tokenId] = {
        id: link.vocabItem.id,
        form: link.vocabItem.form,
        metadata: link.vocabItem.metadata || {},
        vocabId: vocab.id,
        vocabName: vocab.name,
        linkId: link.id,
        // Machine-made and not yet human-confirmed (provenance convention) —
        // the editor renders these distinctly.
        inferred: provState(linkMeta) === PROV_STATES.MACHINE
      };
    });
  });
  return out;
}
