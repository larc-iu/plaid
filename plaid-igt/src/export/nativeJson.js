// The native "Plaid IGT JSON" format (formatVersion 1) — a lossless archive of
// an IGT project in IGT terms: sentences > words > morphemes, fields by scope,
// orthographies, lexicon links, time alignment, provenance. Designed so a
// future importer can rebuild the project (ids are correlation keys, offsets
// are code points, vocab item order is contractual); see docs/native-format.md
// for the full specification.
//
// Pure functions — no client, no Date (timestamps passed in). The document
// serializer walks IgtDocument's derived view for the tree but reaches into
// `.raw` for everything the derived view drops:
//   (a) document metadata beyond the configured fields
//   (b) multi-token vocab links + second links on an already-linked token
//   (f) tokens outside every sentence extent
//   (g) duplicate spans per layer+token beyond the first
// Span entries carry their ids so provenance metadata rides along and so a
// span covering several tokens (which appears once per token in the tree) is
// recognizable as ONE span.

import {
  findBaselineTextLayer, findWordTokenLayer, findSentenceTokenLayer,
  findMorphemeTokenLayer, findAlignmentTokenLayer,
  readScope, readOrthographies, readIgnoredTokens, readDocumentMetadata,
  IGT_NAMESPACE, readVocabFields,
} from '../domain/igtConfig.js';
import { normalizeVocabFields } from '../domain/vocabFields.js';
import { discoverExportLayers } from './exportLayers.js';

export const NATIVE_FORMAT_VERSION = 1;
export const NATIVE_FORMAT_NAME = 'plaid-igt';

const nonEmpty = (obj) => obj != null && Object.keys(obj).length > 0;

// Attach `metadata` only when non-empty ("absent = empty" per the spec).
const withMetadata = (node, metadata) =>
  (nonEmpty(metadata) ? { ...node, metadata } : node);

// ---- project.json -----------------------------------------------------------

const igtLayers = (project) => {
  const textLayer = findBaselineTextLayer(project?.textLayers || []);
  const tokenLayers = textLayer?.tokenLayers || [];
  return {
    textLayer,
    wordLayer: findWordTokenLayer(tokenLayers),
    sentenceLayer: findSentenceTokenLayer(tokenLayers),
    morphemeLayer: findMorphemeTokenLayer(tokenLayers),
    alignmentLayer: findAlignmentTokenLayer(tokenLayers),
  };
};

/**
 * The archive manifest + IGT schema. `documents` / `vocabularies` are the
 * caller-assembled manifest rows ({id, name, file, mediaFile?}).
 */
export function buildProjectFile({ project, documents, vocabularies, asOf = null, exportedAt }) {
  const { textLayer, wordLayer, sentenceLayer, morphemeLayer, alignmentLayer } = igtLayers(project);
  const fields = discoverExportLayers(project);
  const spanLayers = [wordLayer, sentenceLayer, morphemeLayer]
    .flatMap((tl) => tl?.spanLayers || [])
    .map((sl) => ({ id: sl.id, name: sl.name, scope: readScope(sl.config) }));
  return {
    format: NATIVE_FORMAT_NAME,
    formatVersion: NATIVE_FORMAT_VERSION,
    exportedAt,
    asOf: asOf ?? null,
    project: { id: project?.id ?? null, name: project?.name ?? null },
    schema: {
      orthographies: readOrthographies(wordLayer?.config) ?? [],
      fields: {
        sentence: fields.sentFields.map((name) => ({ name })),
        word: fields.wordFields.map((name) => ({ name })),
        morpheme: fields.morphFields.map((name) => ({ name })),
      },
      ignoredTokens: readIgnoredTokens(wordLayer?.config) ?? null,
      documentMetadata: readDocumentMetadata(project?.config) ?? [],
      // Stored config verbatim — defaults are the app's business, not the
      // archive's, so unset stays null.
      autoAnalysis: project?.config?.[IGT_NAMESPACE]?.autoAnalysis ?? null,
    },
    layers: {
      baselineText: textLayer?.id ?? null,
      sentence: sentenceLayer?.id ?? null,
      word: wordLayer?.id ?? null,
      morpheme: morphemeLayer?.id ?? null,
      timeAlignment: alignmentLayer?.id ?? null,
      spanLayers,
    },
    documents,
    vocabularies,
  };
}

// ---- vocabularies/*.json ----------------------------------------------------

/**
 * One vocabulary. Items are sorted by id: UUIDv7 ids encode creation order,
 * which is what homonym subscripts are numbered by — a re-importer must
 * recreate items in array order to preserve them.
 */
export function serializeVocabularyNative(vocab) {
  const fields = normalizeVocabFields(readVocabFields(vocab?.config))
    .map(({ name, inline }) => ({ name, inline }));
  const items = [...(vocab?.items || [])]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((it) => withMetadata({ id: it.id, form: it.form }, it.metadata));
  return { id: vocab?.id ?? null, name: vocab?.name ?? null, fields, items };
}

// ---- documents/*.json -------------------------------------------------------

// {id, value, metadata?} — the span id makes provenance round-trippable and
// lets entries sharing an id across tokens be recognized as one span.
const fieldEntry = (span) =>
  withMetadata({ id: span.id, value: span.value ?? null }, span.metadata);

const fieldEntries = (annotations, emittedSpanIds) => {
  const out = {};
  for (const [name, span] of Object.entries(annotations || {})) {
    if (!span) continue;
    out[name] = fieldEntry(span);
    if (span.id != null) emittedSpanIds.add(span.id);
  }
  return out;
};

// Walk the raw embedded vocab links once: the first single-token link per
// token is inlined on its word/morpheme node (mirroring the derived view's
// first-wins rule); every other link — multi-token, or a second link on an
// already-linked token — goes to extraVocabLinks verbatim.
const linkIndexFromRaw = (raw) => {
  const byToken = new Map();
  const extras = [];
  (raw?.textLayers || []).forEach((tl) => {
    (tl.tokenLayers || []).forEach((tkl) => {
      (tkl.vocabs || []).forEach((vocab) => {
        (vocab.vocabLinks || []).forEach((link) => {
          const itemId = link?.vocabItem?.id ?? link?.vocabItem ?? null;
          const entry = {
            id: link.id,
            vocabId: vocab.id,
            itemId,
            tokens: link.tokens || [],
            metadata: link.metadata,
          };
          if (entry.tokens.length === 1 && !byToken.has(entry.tokens[0])) {
            byToken.set(entry.tokens[0], entry);
          } else {
            extras.push(withMetadata(
              { id: entry.id, vocabId: entry.vocabId, itemId: entry.itemId, tokens: entry.tokens },
              entry.metadata,
            ));
          }
        });
      });
    });
  });
  return { byToken, extras };
};

const vocabRef = (linkIndex, tokenId) => {
  const link = linkIndex.byToken.get(tokenId);
  if (!link) return null;
  return withMetadata(
    { linkId: link.id, vocabId: link.vocabId, itemId: link.itemId },
    link.metadata,
  );
};

// Split a raw token-metadata map: configured `orthog:<name>` keys are lifted
// into `orthographies` (preserving the unset-vs-'' distinction); everything
// else — including UNconfigured orthog:* keys — stays in `metadata`.
const splitOrthographies = (metadata, orthographyNames) => {
  const orthographies = {};
  const rest = { ...(metadata || {}) };
  for (const name of orthographyNames) {
    const key = `orthog:${name}`;
    if (Object.prototype.hasOwnProperty.call(rest, key)) {
      orthographies[name] = rest[key];
      delete rest[key];
    }
  }
  return { orthographies, rest };
};

function morphemeNode(m, linkIndex, ctx) {
  ctx.emittedTokenIds.add(m.id);
  const metadata = { ...(m.metadata || {}) };
  const node = { id: m.id, begin: m.begin, end: m.end, precedence: m.precedence ?? 1, text: m.content ?? '' };
  // form '' is meaningful (present-but-empty) — lift only when the key exists,
  // mirroring morphFormOf's present-vs-absent distinction.
  if (Object.prototype.hasOwnProperty.call(metadata, 'form')) {
    node.form = metadata.form ?? '';
    delete metadata.form;
  }
  if (Object.prototype.hasOwnProperty.call(metadata, 'morphType')) {
    node.morphType = metadata.morphType;
    delete metadata.morphType;
  }
  const out = withMetadata(node, metadata);
  out.fields = fieldEntries(m.annotations, ctx.emittedSpanIds);
  const vocab = vocabRef(linkIndex, m.id);
  if (vocab) out.vocab = vocab;
  return out;
}

function wordNode(token, orthographyNames, linkIndex, ctx) {
  ctx.emittedTokenIds.add(token.id);
  const { orthographies, rest } = splitOrthographies(token.metadata, orthographyNames);
  const node = withMetadata(
    { id: token.id, begin: token.begin, end: token.end, text: token.content ?? '', orthographies },
    rest,
  );
  node.fields = fieldEntries(token.annotations, ctx.emittedSpanIds);
  const vocab = vocabRef(linkIndex, token.id);
  if (vocab) node.vocab = vocab;
  node.morphemes = (token.morphemes || []).map((m) => morphemeNode(m, linkIndex, ctx));
  return node;
}

// Everything in the raw substrate that the sentence tree missed: tokens
// outside every sentence extent (or morphemes matching no word) and spans
// beyond the first per layer+token. Sweeps ALL span layers on the three token
// layers — including ones with no/unknown scope, which the derived view
// ignores entirely. layerInfo references the same live raw objects.
function completenessSweep(layerInfo, ctx) {
  const wordLayer = layerInfo.primaryTokenLayer;
  const sentenceLayer = layerInfo.sentenceTokenLayer;
  const morphemeLayer = layerInfo.morphemeTokenLayer;
  const orphanTokens = [];
  const sweepTokens = (layer, label) => {
    for (const t of layer?.tokens || []) {
      if (ctx.emittedTokenIds.has(t.id)) continue;
      const node = { layer: label, id: t.id, begin: t.begin, end: t.end };
      if (t.precedence != null) node.precedence = t.precedence;
      orphanTokens.push(withMetadata(node, t.metadata));
    }
  };
  sweepTokens(sentenceLayer, 'sentence');
  sweepTokens(wordLayer, 'word');
  sweepTokens(morphemeLayer, 'morpheme');

  const extraSpans = [];
  for (const tl of [wordLayer, sentenceLayer, morphemeLayer]) {
    for (const sl of tl?.spanLayers || []) {
      const scope = readScope(sl.config);
      for (const s of sl.spans || []) {
        if (ctx.emittedSpanIds.has(s.id)) continue;
        extraSpans.push(withMetadata(
          { id: s.id, layer: { name: sl.name, scope }, tokens: s.tokens || [], value: s.value ?? null },
          s.metadata,
        ));
      }
    }
  }
  return { orphanTokens, extraSpans };
}

const alignmentNodes = (alignmentTokens) => (alignmentTokens || []).map((t) => {
  const metadata = { ...(t.metadata || {}) };
  delete metadata.timeBegin;
  delete metadata.timeEnd;
  return withMetadata({
    id: t.id, begin: t.begin, end: t.end,
    timeBegin: t.metadata?.timeBegin ?? null,
    timeEnd: t.metadata?.timeEnd ?? null,
  }, metadata);
});

/**
 * One document. `mediaFile` is the archive path of the embedded media (or
 * null). Offsets are code points into baseline.body; times are seconds.
 */
export function serializeDocumentNative(igtDoc, { mediaFile = null } = {}) {
  const raw = igtDoc.raw || {};
  const layerInfo = igtDoc.layerInfo || {};
  const orthographyNames = (readOrthographies(layerInfo.primaryTokenLayer?.config) || [])
    .map((o) => o?.name)
    .filter((n) => typeof n === 'string' && n !== '');
  const linkIndex = linkIndexFromRaw(raw);
  const ctx = { emittedTokenIds: new Set(), emittedSpanIds: new Set() };

  const sentences = (igtDoc.sortedSentences || []).map((s) => {
    ctx.emittedTokenIds.add(s.id);
    const node = withMetadata(
      { id: s.id, begin: s.begin, end: s.end },
      s.sentenceToken?.metadata,
    );
    node.fields = fieldEntries(s.annotations, ctx.emittedSpanIds);
    node.words = (s.tokens || []).map((t) => wordNode(t, orthographyNames, linkIndex, ctx));
    return node;
  });

  const { orphanTokens, extraSpans } = completenessSweep(layerInfo, ctx);
  const text = layerInfo.primaryTextLayer?.text;

  return {
    id: raw.id ?? null,
    name: raw.name ?? null,
    version: raw.version ?? null,
    mediaFile,
    metadata: raw.metadata || {}, // wholesale — the derived view filters this
    baseline: withMetadata(
      { textId: text?.id ?? null, body: text?.body ?? '' },
      text?.metadata,
    ),
    sentences,
    alignment: alignmentNodes(igtDoc.alignmentTokens),
    extraVocabLinks: linkIndex.extras,
    extraSpans,
    orphanTokens,
  };
}
