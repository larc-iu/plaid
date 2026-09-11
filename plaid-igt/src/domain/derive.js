// Pure derivation functions. Take a raw plaid-client document + its layer
// info + project + vocabularies; return the render-friendly view used by the
// editor. Cached in IgtDocument by `_version`.
//
// This is the documentParser.js logic relocated and trimmed to be a pure fn
// over arguments instead of constructing its own state. Note the lookup maps
// (tokenLookup, sentenceLookup, tokenPositionMaps, sentenceIndexLookup,
// findSentenceForToken) are produced together so they stay in sync with
// `sentences`.

import { provState, provOrigin } from '@larc-iu/plaid-client';
import { lexiconView } from './vocabDictionary.js';
import { itemsById, linkedItem } from './vocabLookup.js';
import {
  readDocumentMetadata,
  readOrthographies,
  readIgnoredTokens,
  isTokenIgnored,
} from './igtConfig.js';
import { virtualMorphemeId } from './virtualMorpheme.js';
import { collectMweLinks, bracketPieces, assignLanes } from './mwe.js';

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
    fields.forEach((field) => {
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
    metadata: configuredMetadata,
  };
}

export function deriveAlignmentTokens(layerInfo) {
  const layer = layerInfo.alignmentTokenLayer;
  if (!layer || !Array.isArray(layer.tokens)) return [];
  return [...layer.tokens]
    .map((t) => ({ ...t, annotations: {} }))
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
  const entryTypes = collectEntryMorphTypes(vocabularies);

  const sortedTokens = (primaryTokenLayer?.tokens || [])
    .map((t) => ({
      id: t.id,
      text: t.text,
      begin: t.begin,
      end: t.end,
      content: sliceBody(t.begin, t.end),
      metadata: t.metadata || {},
      annotations: {},
      orthographies: collectOrthographies(t, primaryTokenLayer),
      vocabItem: vocabLinksByToken[t.id] || null,
      morphemes: [],
    }))
    .sort((a, b) => a.begin - b.begin);

  // Per-layer tokenId -> span maps, built in ONE pass over each layer's spans
  // (first span per token wins, matching the old `.find` order). Annotation
  // collection is then O(layers) per item; the previous scan-all-spans-per-item
  // approach was quadratic and took seconds on real (FLEx-imported) documents.
  const buildSpanMaps = (layers) =>
    (layers || []).map((sl) => {
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
    sortedTokens.forEach((w) => wordKey.set(`${w.begin}-${w.end}`, w));
    (morphemeTokenLayer.tokens || []).forEach((m) => {
      const parent = wordKey.get(`${m.begin}-${m.end}`);
      if (!parent) return;
      const vocabItem = vocabLinksByToken[m.id] || null;
      const entry = {
        id: m.id,
        text: m.text,
        begin: m.begin,
        end: m.end,
        precedence: m.precedence ?? 1,
        content: sliceBody(m.begin, m.end),
        metadata: m.metadata || {},
        annotations: annotationsFor(m.id, morphSpanMaps),
        vocabItem,
        // Effective morph type: a linked lexicon entry's type (its own, else
        // its headword's) overrides the token's own metadata.morphType (the
        // token copy is a cache for unlinked morphemes and for consumers that
        // don't see the lexicon; reconcile-on-open keeps it in sync while the
        // entry has a type). Read THIS everywhere in the app — joiners,
        // exports, the popover's Type row, the stem chip.
        morphType: effectiveMorphType(m.metadata, vocabItem, entryTypes),
        // The entry's side of that alone, for reconcile's cache sync.
        entryMorphType: entryMorphType(vocabItem, entryTypes),
      };
      if (!morphemesByWord.has(parent.id)) morphemesByWord.set(parent.id, []);
      morphemesByWord.get(parent.id).push(entry);
    });
    morphemesByWord.forEach((arr) => arr.sort((a, b) => a.precedence - b.precedence));
  }

  // A word nobody has analyzed yet gets a morpheme anyway, synthesized here
  // rather than stored (see virtualMorpheme.js). It is the word: same extent,
  // same text, no annotation. Consumers of `token.morphemes` therefore see one
  // morpheme per word whether or not anyone has segmented it, which is what
  // they saw when reconcile-on-open wrote these rows into the database.
  //
  // Ignored tokens (punctuation, per the project's ignored-tokens config) are
  // excluded, exactly as reconcile excluded them: they carry no annotation and
  // the editor renders them as gaps, so a morpheme there would be invisible.
  const ignoredCfg = readIgnoredTokens(primaryTokenLayer?.config);
  const emptyMorphAnnotations = annotationsFor(null, morphSpanMaps);
  const virtualMorpheme = (word) => ({
    id: virtualMorphemeId(word.id),
    virtual: true,
    text: word.text,
    begin: word.begin,
    end: word.end,
    precedence: 1,
    content: word.content,
    metadata: {},
    annotations: { ...emptyMorphAnnotations },
    // Nothing is linked to it and it has no metadata, so both morph types are
    // null by construction rather than by lookup: there is no entry to ask.
    vocabItem: null,
    morphType: null,
    entryMorphType: null,
  });
  const morphemesOf = (word) => {
    const own = morphemesByWord.get(word.id);
    if (own && own.length) return own;
    if (!morphemeTokenLayer) return [];
    if (isTokenIgnored(word.content, ignoredCfg)) return [];
    return [virtualMorpheme(word)];
  };

  // Sentence bucketing.
  const sentenceTokens = [...(sentenceTokenLayer?.tokens || [])]
    .map((s) => ({
      id: s.id,
      text: s.text || '',
      begin: s.begin,
      end: s.end,
      sentenceToken: s,
      annotations: {},
    }))
    .sort((a, b) => a.begin - b.begin);

  // Single sweep over the begin-sorted tokens (sentences are a begin-sorted
  // partition), instead of filtering the whole token list per sentence.
  let ti = 0;
  const enrichedSentences = sentenceTokens.map((sentence) => {
    while (ti < sortedTokens.length && sortedTokens[ti].begin < sentence.begin) ti++;
    const tokensInSentence = [];
    while (ti < sortedTokens.length && sortedTokens[ti].begin < sentence.end) {
      const t = sortedTokens[ti];
      if (t.begin >= sentence.begin && t.end <= sentence.end) {
        tokensInSentence.push({
          ...t,
          annotations: annotationsFor(t.id, wordSpanMaps),
          morphemes: morphemesOf(t),
        });
      }
      ti++;
    }
    const sentenceAnnotations = annotationsFor(sentence.id, sentSpanMaps);
    return {
      ...sentence,
      annotations: sentenceAnnotations,
      tokens: tokensInSentence,
      pieces: [],
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

  attachMwes(enrichedSentences, tokenPositionMaps, collectMweLinks(vocabularies));

  // Pieces (tokens interleaved with the text no token covers) are COPIES of
  // the token objects, so they are made only now, once the tokens carry their
  // multi-word expression bracket pieces.
  enrichedSentences.forEach((s) => {
    s.pieces = computePieces(s, s.tokens, sliceBody);
  });

  return {
    sentences: enrichedSentences,
    sortedSentences,
    tokenLookup,
    sentenceLookup,
    tokenPositionMaps,
    sentenceIndexLookup,
    findSentenceForToken,
  };
}

// Multi-word expressions (MWEs, links over two or more word tokens) are drawn in the
// sentence of their first live member: `sentence.mwes` lists them with
// their lane and member columns, `sentence.mweLanes` says how many
// bracket lines the sentence's word band needs, and every word token carries
// `mwePieces[lane]` — the piece of bracket its column draws on that lane, or
// null. A member in another sentence, or one whose token no longer exists,
// stays out of the drawing (`partial` marks the MWE so the validators
// can say so); an MWE with fewer than two live members here is not
// drawn at all. Mutates the derived sentences in place.
function attachMwes(sentences, tokenPositionMaps, mweLinks) {
  const perSentence = new Map();
  sentences.forEach((s) => {
    s.mwes = [];
    s.mweLanes = 0;
    s.tokens.forEach((t) => {
      t.mwePieces = [];
    });
    perSentence.set(s.id, []);
  });
  if (!mweLinks.length) return;

  const sentenceOfToken = new Map();
  sentences.forEach((s) => s.tokens.forEach((t) => sentenceOfToken.set(t.id, s)));

  for (const ex of mweLinks) {
    const placed = ex.tokenIds
      .map((id) => ({ id, sentence: sentenceOfToken.get(id) }))
      .filter((p) => p.sentence);
    if (!placed.length) continue;
    const home = placed.reduce(
      (a, p) => (p.sentence.begin < a.begin ? p.sentence : a),
      placed[0].sentence,
    );
    const posMap = tokenPositionMaps.get(home.id);
    const here = placed.filter((p) => p.sentence === home);
    if (here.length < 2) continue;
    const memberIdx = here.map((p) => posMap.get(p.id)).sort((a, b) => a - b);
    perSentence.get(home.id).push({
      ...ex,
      memberIdx,
      memberTokenIds: memberIdx.map((i) => home.tokens[i].id),
      first: memberIdx[0],
      last: memberIdx[memberIdx.length - 1],
      partial: here.length !== ex.tokenIds.length,
    });
  }

  perSentence.forEach((mwes, sentenceId) => {
    if (!mwes.length) return;
    const sentence = sentences.find((s) => s.id === sentenceId);
    const lanes = assignLanes(mwes.map((e) => ({ first: e.first, last: e.last })));
    mwes.forEach((e, i) => {
      e.lane = lanes[i];
    });
    mwes.sort((a, b) => a.lane - b.lane || a.first - b.first);
    const laneCount = Math.max(...lanes) + 1;
    sentence.mwes = mwes;
    sentence.mweLanes = laneCount;
    sentence.tokens.forEach((t) => {
      t.mwePieces = new Array(laneCount).fill(null);
    });
    for (const e of mwes) {
      const pieces = bracketPieces(sentence.tokens.length, e.memberIdx);
      pieces.forEach((piece, i) => {
        if (piece) sentence.tokens[i].mwePieces[e.lane] = { piece, mwe: e };
      });
    }
  });
}

/**
 * The morph type a linked entry gives a token: the entry's own, else its
 * headword's (`morphTypeOf`), read through `entryTypes` (item id -> type)
 * when the caller has built that map over the lexicon. Null when the entry
 * and everything above it are untyped.
 */
export const entryMorphType = (vocabItem, entryTypes = null) => {
  const resolved = entryTypes?.get(vocabItem?.id);
  const fromItem = resolved ?? vocabItem?.metadata?.morphType;
  return typeof fromItem === 'string' && fromItem !== '' ? fromItem : null;
};

/** A morpheme's effective type: the linked entry's, else the token's own. */
export const effectiveMorphType = (tokenMetadata, vocabItem, entryTypes = null) =>
  entryMorphType(vocabItem, entryTypes) ?? tokenMetadata?.morphType ?? null;

/**
 * item id -> the morph type it goes by, over every vocabulary: its own, else
 * its headword's. A sense made by hand carries none of its own.
 */
export const collectEntryMorphTypes = (vocabularies) => {
  const out = new Map();
  for (const vocab of Object.values(vocabularies || {})) {
    const view = lexiconView(vocab.items || []);
    for (const it of vocab.items || []) out.set(it.id, view.morphTypeOf(it.id));
  }
  return out;
};

function collectOrthographies(token, primaryTokenLayer) {
  const out = {};
  const configs = readOrthographies(primaryTokenLayer?.config) || [];
  configs.forEach((c) => {
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
        end: t.begin,
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
      end: sentence.end,
    });
  }
  return pieces;
}

function makeBinarySearchSentenceLookup(sortedSentences) {
  return function findSentenceForToken(token) {
    if (!token || typeof token.begin !== 'number' || typeof token.end !== 'number') return null;
    let lo = 0,
      hi = sortedSentences.length - 1;
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
  Object.values(vocabularies || {}).forEach((vocab) => {
    const byId = itemsById(vocab);
    (vocab.vocabLinks || []).forEach((link) => {
      if (!Array.isArray(link.tokens) || link.tokens.length !== 1 || !link.vocabItem) return;
      const tokenId = link.tokens[0];
      const linkMeta = link.metadata || {};
      out[tokenId] = {
        ...linkedItem(byId, link),
        vocabId: vocab.id,
        vocabName: vocab.name,
        linkId: link.id,
        // Provenance state ('human' | 'machine' | 'contributed' | 'verified')
        // of the LINK — the editor renders each distinctly; the auto-linker
        // and analysis memory treat 'machine' as replaceable/unvouched.
        // provOrigin (null | 'inferred' | 'contributed') is what a verified
        // link's tooltip needs, since the state folds both origins.
        prov: provState(linkMeta),
        provOrigin: provOrigin(linkMeta),
      };
    });
  });
  return out;
}
