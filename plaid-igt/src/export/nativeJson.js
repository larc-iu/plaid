// The native "Plaid IGT JSON" format (formatVersion 1) — a lossless archive of
// an IGT project in IGT terms: sentences > words > morphemes, fields by scope,
// orthographies, lexicon links, time alignment, provenance, and the comments
// left on any of it (the only export target that carries those). Designed so a
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
  findBaselineTextLayer,
  findWordTokenLayer,
  findSentenceTokenLayer,
  findMorphemeTokenLayer,
  findAlignmentTokenLayer,
  readScope,
  readOrthographies,
  readIgnoredTokens,
  readDocumentMetadata,
  IGT_NAMESPACE,
  readVocabFields,
} from '../domain/igtConfig.js';
import { readTagsetName } from '../domain/tagsets.js';
import { normalizeVocabFields } from '../domain/vocabFields.js';
import { discoverExportLayers } from './exportLayers.js';

export const NATIVE_FORMAT_VERSION = 1;
export const NATIVE_FORMAT_NAME = 'plaid-igt';

const nonEmpty = (obj) => obj != null && Object.keys(obj).length > 0;

// Attach `metadata` only when non-empty ("absent = empty" per the spec).
const withMetadata = (node, metadata) => (nonEmpty(metadata) ? { ...node, metadata } : node);

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
  const allSpanLayers = [wordLayer, sentenceLayer, morphemeLayer, alignmentLayer].flatMap(
    (tl) => tl?.spanLayers || [],
  );
  const spanLayers = allSpanLayers.map((sl) => ({
    id: sl.id,
    name: sl.name,
    scope: readScope(sl.config),
  }));
  // Which tagset governs each field. Carried on the field rather than on the
  // layer row because the importer builds fields from `schema.fields`, and a
  // tagset that arrives without its field is a list nothing enforces.
  const tagsetOf = new Map(
    allSpanLayers.map((sl) => [`${readScope(sl.config)}:${sl.name}`, readTagsetName(sl.config)]),
  );
  const fieldRow = (scope) => (name) => {
    const tagset = tagsetOf.get(`${scope}:${name}`);
    return tagset ? { name, tagset } : { name };
  };
  // Project config this app owns, stored verbatim: defaults are the app's
  // business, not the archive's, so unset stays null.
  const igtConfig = (key) => project?.config?.[IGT_NAMESPACE]?.[key] ?? null;
  return {
    format: NATIVE_FORMAT_NAME,
    formatVersion: NATIVE_FORMAT_VERSION,
    exportedAt,
    asOf: asOf ?? null,
    project: { id: project?.id ?? null, name: project?.name ?? null },
    schema: {
      orthographies: readOrthographies(wordLayer?.config) ?? [],
      fields: {
        sentence: fields.sentFields.map(fieldRow('Sentence')),
        word: fields.wordFields.map(fieldRow('Word')),
        morpheme: fields.morphFields.map(fieldRow('Morpheme')),
      },
      ignoredTokens: readIgnoredTokens(wordLayer?.config) ?? null,
      documentMetadata: readDocumentMetadata(project?.config) ?? [],
      autoAnalysis: igtConfig('autoAnalysis'),
      tagsets: igtConfig('tagsets'),
      languages: igtConfig('languages'),
      speakers: igtConfig('speakers'),
      serviceDefaults: igtConfig('serviceDefaults'),
      compose: igtConfig('compose'),
      exportPresets: igtConfig('export'),
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
 * One vocabulary. Items keep the order the server returned them in, which IS
 * creation order, and a re-importer recreates them in array order to preserve
 * it (homonym subscripts are numbered by creation order).
 *
 * Do NOT re-sort by id. UUIDv7 ids only order across MILLISECONDS, and a bulk
 * import writes thousands of items inside one millisecond, where the rest of
 * the id is random. Sorting by id therefore shuffles every batch: it was
 * measured scrambling a 4,591-item lexicon down to 9 items still in place, so
 * each export/import cycle permuted the whole vocabulary.
 */
export function serializeVocabularyNative(vocab, { comments = [], onWarning = null } = {}) {
  // A field's `tagset` names one of the vocabulary's own tagsets (below) and
  // `lang` is a FLEx custom field's writing system; both are carried only
  // when set, so a plain field stays `{name, inline}`.
  const fields = normalizeVocabFields(readVocabFields(vocab?.config)).map(
    ({ name, inline, tagset, lang }) => ({
      name,
      inline,
      ...(tagset ? { tagset } : {}),
      ...(lang ? { lang } : {}),
    }),
  );
  const items = (vocab?.items || []).map((it) =>
    withMetadata({ id: it.id, form: it.form }, it.metadata),
  );
  // The vocabulary's tagsets, verbatim like the project's: null when unset.
  const tagsets = vocab?.config?.[IGT_NAMESPACE]?.tagsets ?? null;
  // Comments on the vocabulary's entries. An entry is the only thing in a
  // vocabulary a comment can be about, so a comment whose entry is not in
  // `items` is one whose entry has been deleted.
  const itemIds = new Set(items.map((it) => it.id));
  const nodes = commentNodes(comments, (type, id) => type === 'vocab-item' && itemIds.has(id));
  const dropped = (comments || []).length - nodes.length;
  if (dropped > 0) onWarning?.(`${plural(dropped, 'comment')} on deleted entries not exported`);
  return {
    id: vocab?.id ?? null,
    name: vocab?.name ?? null,
    fields,
    tagsets,
    items,
    ...(nodes.length ? { comments: nodes } : {}),
  };
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

// Walk the raw embedded vocab links once. A link is a candidate for inlining
// on its word/morpheme node when it targets exactly one token and carries an
// item; among several such links on one token, the LAST wins — matching what
// the editor displays (derive.js collectSingleTokenVocabLinks overwrites).
// Everything else — multi-token links, item-less links, displaced earlier
// links — goes to extraVocabLinks verbatim. Candidates whose token never
// appears in the sentence tree are flushed to extras at the end
// (consumeRemaining), so links on orphan/sentence/alignment tokens are never
// silently dropped.
const extraLinkOf = (entry) =>
  withMetadata(
    { id: entry.id, vocabId: entry.vocabId, itemId: entry.itemId, tokens: entry.tokens },
    entry.metadata,
  );

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
          if (entry.tokens.length === 1 && itemId != null) {
            const displaced = byToken.get(entry.tokens[0]);
            if (displaced) extras.push(extraLinkOf(displaced));
            byToken.set(entry.tokens[0], entry);
          } else {
            extras.push(extraLinkOf(entry));
          }
        });
      });
    });
  });
  return {
    extras,
    consume(tokenId) {
      const link = byToken.get(tokenId);
      if (!link) return null;
      byToken.delete(tokenId);
      return withMetadata(
        { linkId: link.id, vocabId: link.vocabId, itemId: link.itemId },
        link.metadata,
      );
    },
    consumeRemaining() {
      for (const entry of byToken.values()) extras.push(extraLinkOf(entry));
      byToken.clear();
    },
  };
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
  const node = {
    id: m.id,
    begin: m.begin,
    end: m.end,
    precedence: m.precedence ?? 1,
    text: m.content ?? '',
  };
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
  const vocab = linkIndex.consume(m.id);
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
  const vocab = linkIndex.consume(token.id);
  if (vocab) node.vocab = vocab;
  node.morphemes = (token.morphemes || []).map((m) => morphemeNode(m, linkIndex, ctx));
  return node;
}

// Everything in the raw substrate that the sentence tree missed: tokens
// outside every sentence extent (or morphemes matching no word), spans beyond
// the first per layer+token, AND spans the tree did emit whose token list
// reaches outside the tree — field entries carry no token list, so a span
// over [tree token, orphan token] needs its full record here for the
// membership to survive (the spec makes the extraSpans record authoritative
// when its id also appears as a field entry). Sweeps ALL span layers on all
// four token layers — including unscoped layers and the alignment layer's,
// which the derived view ignores entirely. layerInfo references the same
// live raw objects.
function completenessSweep(layerInfo, ctx) {
  const wordLayer = layerInfo.primaryTokenLayer;
  const sentenceLayer = layerInfo.sentenceTokenLayer;
  const morphemeLayer = layerInfo.morphemeTokenLayer;
  const alignmentLayer = layerInfo.alignmentTokenLayer;
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
  for (const tl of [wordLayer, sentenceLayer, morphemeLayer, alignmentLayer]) {
    for (const sl of tl?.spanLayers || []) {
      const scope = readScope(sl.config);
      for (const s of sl.spans || []) {
        const tokens = s.tokens || [];
        const inTree = ctx.emittedSpanIds.has(s.id);
        if (inTree && tokens.every((t) => ctx.emittedTokenIds.has(t))) continue;
        extraSpans.push(
          withMetadata(
            {
              id: s.id,
              layer: { id: sl.id, name: sl.name, scope },
              tokens,
              value: s.value ?? null,
            },
            s.metadata,
          ),
        );
      }
    }
  }
  return { orphanTokens, extraSpans };
}

const alignmentNodes = (alignmentTokens) =>
  (alignmentTokens || []).map((t) => {
    const metadata = { ...(t.metadata || {}) };
    delete metadata.timeBegin;
    delete metadata.timeEnd;
    return withMetadata(
      {
        id: t.id,
        begin: t.begin,
        end: t.end,
        timeBegin: t.metadata?.timeBegin ?? null,
        timeEnd: t.metadata?.timeEnd ?? null,
      },
      metadata,
    );
  });

/**
 * Comment nodes for an archive file. Comments are SOCIAL data and behave
 * unlike everything else archived here: they carry an identity (the author id
 * IS an email) and wall-clock times that are not the export's own, and they
 * are not versioned, so `asOf` exports omit them entirely (see runExport).
 *
 * `archived(type, id)` says whether the anchor is in the file being written.
 * A comment outlives its anchor on the server, and a project holds entities
 * this archive does not carry (relations belong to whichever app owns them,
 * UD's dependency arcs say), so a comment can be about something the file has
 * no node for. Such a comment is dropped here: a re-importer would have
 * nothing to hang it on, and the server refuses a comment on a missing anchor.
 * The caller counts what was dropped and warns once per file.
 *
 * `anchor.id` and `id` are correlation keys like every other id in the
 * archive. `author.name` is the display name AT EXPORT TIME — a label, since
 * display names change and the id is the identity. `anchorLabel` is the
 * caption the comment was posted with (what it is about, in words); it is
 * what a comment shows once its anchor is gone.
 */
export function commentNodes(comments, archived = () => true) {
  return (comments || [])
    .filter((c) => c && archived(c.entityType, c.entityId))
    .map((c) => ({
      id: c.id,
      anchor: { type: c.entityType, id: c.entityId },
      anchorLabel: c.anchorLabel ?? null,
      author: { id: c.author?.id ?? null, name: c.author?.name ?? null },
      body: c.body ?? '',
      createdAt: c.createdAt ?? null,
      updatedAt: c.updatedAt ?? null,
    }));
}

const plural = (n, noun) => `${n} ${noun}${n === 1 ? '' : 's'}`;

/**
 * One document. `mediaFile` is the archive path of the embedded media (or
 * null). Offsets are code points into baseline.body; times are seconds.
 * `comments` are the document's, shaped by runExport's loader; `onWarning`
 * hears how many of them the file could not carry.
 */
export function serializeDocumentNative(
  igtDoc,
  { mediaFile = null, comments = [], onWarning = null } = {},
) {
  const raw = igtDoc.raw || {};
  const layerInfo = igtDoc.layerInfo || {};
  const orthographyNames = (readOrthographies(layerInfo.primaryTokenLayer?.config) || [])
    .map((o) => o?.name)
    .filter((n) => typeof n === 'string' && n !== '');
  const linkIndex = linkIndexFromRaw(raw);
  const ctx = { emittedTokenIds: new Set(), emittedSpanIds: new Set() };

  const sentences = (igtDoc.sortedSentences || []).map((s) => {
    ctx.emittedTokenIds.add(s.id);
    const node = withMetadata({ id: s.id, begin: s.begin, end: s.end }, s.sentenceToken?.metadata);
    node.fields = fieldEntries(s.annotations, ctx.emittedSpanIds);
    node.words = (s.tokens || []).map((t) => wordNode(t, orthographyNames, linkIndex, ctx));
    return node;
  });

  // Every alignment token is exported (the `alignment` array), so they count
  // as reachable for the span sweep's membership check.
  for (const t of igtDoc.alignmentTokens || []) ctx.emittedTokenIds.add(t.id);
  // Inline-candidate links whose token never appeared in the tree (links on
  // orphan/sentence/alignment tokens) must still be archived.
  linkIndex.consumeRemaining();

  const { orphanTokens, extraSpans } = completenessSweep(layerInfo, ctx);
  const text = layerInfo.primaryTextLayer?.text;

  // What this file has a node for: the tree, the alignment, and the sweep's
  // leftovers. A comment anchored anywhere else is dropped (see commentNodes).
  const tokenIds = new Set(ctx.emittedTokenIds);
  for (const t of orphanTokens) tokenIds.add(t.id);
  const spanIds = new Set(ctx.emittedSpanIds);
  for (const sp of extraSpans) spanIds.add(sp.id);
  const archived = (type, id) => {
    switch (type) {
      case 'document':
        return id != null && id === raw.id;
      case 'text':
        return id != null && id === text?.id;
      case 'token':
        return tokenIds.has(id);
      case 'span':
        return spanIds.has(id);
      default:
        return false;
    }
  };
  const nodes = commentNodes(comments, archived);
  const dropped = (comments || []).length - nodes.length;
  if (dropped > 0) {
    onWarning?.(
      `${plural(dropped, 'comment')} not exported (what they are about is deleted, or belongs to another app)`,
    );
  }

  return {
    id: raw.id ?? null,
    name: raw.name ?? null,
    version: raw.version ?? null,
    mediaFile,
    metadata: raw.metadata || {}, // wholesale — the derived view filters this
    baseline: withMetadata({ textId: text?.id ?? null, body: text?.body ?? '' }, text?.metadata),
    sentences,
    alignment: alignmentNodes(igtDoc.alignmentTokens),
    extraVocabLinks: linkIndex.extras,
    extraSpans,
    orphanTokens,
    ...(nodes.length ? { comments: nodes } : {}),
  };
}
