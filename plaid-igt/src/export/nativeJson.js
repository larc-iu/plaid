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
//
// Other Plaid apps sharing the project are carried too, without this app
// knowing anything about them: every layer on the baseline text layer that it
// does not own, with its config, tokens, spans and relations, as plain Plaid
// data (`otherLayers`, see domain/otherLayers.js).

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
  readFieldLang,
} from '../domain/igtConfig.js';
import { PLAID_NAMESPACE, ROLES } from '@larc-iu/plaid-client';
import { readTagsetName } from '../domain/tagsets.js';
import { normalizeVocabFields } from '../domain/vocabFields.js';
import {
  configWithout,
  otherTokenLayers,
  ownTokenLayers,
  parentsFirst,
} from '../domain/otherLayers.js';
import { discoverExportLayers } from './exportLayers.js';

export const NATIVE_FORMAT_VERSION = 1;
const NATIVE_FORMAT_NAME = 'plaid-igt';

const nonEmpty = (obj) => obj != null && Object.keys(obj).length > 0;

// Attach `metadata` only when non-empty ("absent = empty" per the spec).
const withMetadata = (node, metadata) => (nonEmpty(metadata) ? { ...node, metadata } : node);

// See the note where this is used, on vocabulary items.
const IMPORT_KEYS = ['nativeImportId'];
const withoutImportKeys = (metadata) => {
  if (!metadata || !IMPORT_KEYS.some((k) => k in metadata)) return metadata;
  const out = { ...metadata };
  for (const k of IMPORT_KEYS) delete out[k];
  return out;
};

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
 *
 * `guidelines` is the project's annotation manual, inline rather than in files
 * of its own: there are a handful, each capped at 20000 characters, and
 * nothing in the archive refers to one by id.
 */
export function buildProjectFile({
  project,
  documents,
  vocabularies,
  guidelines = [],
  asOf = null,
  exportedAt,
}) {
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
  // The language a field records (config.igt.lang) travels with it: a FLEx or
  // ELAN import wrote it there, the FLEx and LIFT exports tag each field by
  // it, and an archive that dropped it brought a project back mislabelling
  // its glosses.
  const langOf = new Map(
    allSpanLayers.map((sl) => [`${readScope(sl.config)}:${sl.name}`, readFieldLang(sl.config)]),
  );
  const fieldRow = (scope) => (name) => {
    const tagset = tagsetOf.get(`${scope}:${name}`);
    const lang = langOf.get(`${scope}:${name}`);
    return { name, ...(tagset ? { tagset } : {}), ...(lang ? { lang } : {}) };
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
    // What other apps keep in the project, carried without being understood:
    // their project settings, and their layers with the settings on them.
    // `plaid` is left out of the settings because it holds whose work is
    // reviewed, which names users and so goes with permissions.
    otherConfig: configWithout(project?.config, [IGT_NAMESPACE, PLAID_NAMESPACE]),
    otherLayers: describeOtherLayers(textLayer),
    documents,
    vocabularies,
    // What the project has decided, in its own words. Every other thing a
    // project says about itself is in `schema` above; this is the one that is
    // prose rather than configuration, so it stands beside the content.
    guidelines: (guidelines || []).map((g) => ({
      title: g.title ?? '',
      body: g.body ?? '',
      pinned: !!g.pinned,
    })),
  };
}

const relationLayerRows = (spanLayer) =>
  (spanLayer.relationLayers || []).map((rl) => ({
    id: rl.id,
    name: rl.name ?? null,
    config: rl.config || {},
  }));

/**
 * Everything on the baseline text layer that another app put there, as layer
 * descriptions an importer can make again (see domain/otherLayers.js).
 *
 * - `config`: what this app's own text and token layers hold under namespaces
 *   other than `igt` and `plaid`, by role. Setup writes those two itself.
 * - `spanLayers`: span layers on this app's token layers that it has no field
 *   for, plus any field that other apps hang relation layers or settings on.
 *   The spans on them are in each document already (a field's in the tree, the
 *   rest in `extraSpans`), so only the layer, its settings and its relation
 *   layers are described here.
 * - `tokenLayers`: every other token layer, parents before the layers nested
 *   in them, with its span and relation layers. The parent is named by role
 *   when it is one of this app's layers, and by id when it is another of
 *   these, since only this app's layers are known to the importer by role.
 *
 * A token layer's overlap mode and parent are not in a project read, so the
 * caller supplies them on the layer (`overlapMode`, `parentTokenLayer`).
 */
function describeOtherLayers(textLayer) {
  const tokenLayers = textLayer?.tokenLayers || [];
  const own = ownTokenLayers(tokenLayers);
  const roleOf = new Map(own.map(([role, layer]) => [layer.id, role]));

  const config = {};
  for (const [role, layer] of [[ROLES.BASELINE, textLayer], ...own]) {
    const rest = configWithout(layer?.config, [IGT_NAMESPACE, PLAID_NAMESPACE]);
    if (nonEmpty(rest)) config[role] = rest;
  }

  const spanLayers = [];
  for (const [role, layer] of own) {
    for (const sl of layer.spanLayers || []) {
      const scope = readScope(sl.config);
      const rest = configWithout(sl.config, [IGT_NAMESPACE]);
      const relationLayers = relationLayerRows(sl);
      if (scope && !nonEmpty(rest) && !relationLayers.length) continue;
      spanLayers.push({
        id: sl.id,
        tokenLayer: role,
        scope,
        name: sl.name ?? null,
        config: rest,
        relationLayers,
      });
    }
  }

  const parentRef = (id) => {
    if (id == null) return null;
    return roleOf.has(id) ? { role: roleOf.get(id) } : { id };
  };
  const others = parentsFirst(otherTokenLayers(tokenLayers), (tl) => tl.parentTokenLayer);
  return {
    config,
    spanLayers,
    tokenLayers: others.map((tl) => ({
      id: tl.id,
      name: tl.name ?? null,
      overlapMode: tl.overlapMode ?? null,
      parent: parentRef(tl.parentTokenLayer),
      config: tl.config || {},
      spanLayers: (tl.spanLayers || []).map((sl) => ({
        id: sl.id,
        name: sl.name ?? null,
        config: sl.config || {},
        relationLayers: relationLayerRows(sl),
      })),
    })),
  };
}

// ---- vocabularies/*.json ----------------------------------------------------

/**
 * One vocabulary. Items keep the order the server returned them in, which IS
 * creation order, and a re-importer recreates them in array order to preserve
 * it (entries spelled alike are numbered by creation order).
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
  // `type`, `many` and `scope` say a field is an Entry field or a
  // headword-only one, written only when set, like the others.
  const fields = normalizeVocabFields(readVocabFields(vocab?.config)).map(
    ({ name, inline, tagset, lang, type, many, scope }) => ({
      name,
      inline,
      ...(tagset ? { tagset } : {}),
      ...(lang ? { lang } : {}),
      ...(type === 'item' ? { type } : {}),
      ...(type === 'item' && many ? { many: true } : {}),
      ...(scope === 'entry' ? { scope } : {}),
    }),
  );
  // `nativeImportId` is bookkeeping this app stamps on an entry it created from
  // an archive: it dedupes a resumed import and points back at the source.
  // It is not the project's data, and carrying it out again made the archive
  // non-idempotent, since importing and re-exporting added a key to all 598
  // entries that had not been there the first time. Dedup does not need it in
  // the file: an archive entry is matched by its `id` above, which is the
  // entry's own, and the importer stamps a fresh one on whatever it creates.
  const items = (vocab?.items || []).map((it) =>
    withMetadata({ id: it.id, form: it.form }, withoutImportKeys(it.metadata)),
  );
  // The vocabulary's tagsets, verbatim like the project's: null when unset.
  const tagsets = vocab?.config?.[IGT_NAMESPACE]?.tagsets ?? null;
  // What other apps keep on the vocabulary, verbatim: plaid-dict's
  // publication record lives under `config.dict`, and a dictionary that lost
  // it on the way through an archive would come back as no dictionary at all.
  const config = Object.fromEntries(
    Object.entries(vocab?.config || {}).filter(([ns]) => ns !== IGT_NAMESPACE),
  );
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
    ...(Object.keys(config).length ? { config } : {}),
    items,
    ...(nodes.length ? { comments: nodes } : {}),
  };
}

// ---- documents/*.json -------------------------------------------------------

// {id, value, metadata?} — the span id makes provenance round-trippable and
// lets entries sharing an id across tokens be recognized as one span.
// Where each annotation and vocab link sits in the order the project holds
// them. Which of two on one token the editor shows is decided by that order,
// so it is data: an archive that did not record it brought a project back
// showing the other one, since the tree's annotations were created before the
// extras whatever their order had been.
//
// Ranked by id, which core mints in order (plaid.sql.common/new-uuid), rather
// than by the order this walk meets them: the walk goes layer by layer, so its
// numbering would differ between a project and its re-import even when both
// hold the same order.
function serverOrder(raw) {
  const ids = [];
  for (const tl of raw?.textLayers || []) {
    for (const tkl of tl.tokenLayers || []) {
      for (const sl of tkl.spanLayers || []) for (const s of sl.spans || []) ids.push(s.id);
      for (const v of tkl.vocabs || []) for (const l of v.vocabLinks || []) ids.push(l.id);
    }
  }
  ids.sort();
  return new Map(ids.map((id, i) => [id, i]));
}

const fieldEntry = (span, order) =>
  withMetadata(
    { id: span.id, value: span.value ?? null, ...orderOf(order, span.id) },
    span.metadata,
  );

const orderOf = (order, id) => {
  const at = order?.get(id);
  return at == null ? {} : { order: at };
};

const fieldEntries = (annotations, emittedSpanIds, order) => {
  const out = {};
  for (const [name, span] of Object.entries(annotations || {})) {
    if (!span) continue;
    out[name] = fieldEntry(span, order);
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
    {
      id: entry.id,
      vocabId: entry.vocabId,
      itemId: entry.itemId,
      tokens: entry.tokens,
      order: entry.order,
    },
    entry.metadata,
  );

const linkIndexFromRaw = (raw, order) => {
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
            // The same rank a span carries, and for the same reason: among two
            // links on one token the editor shows the last.
            order: order?.get(link.id),
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
        { linkId: link.id, vocabId: link.vocabId, itemId: link.itemId, order: link.order },
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
  out.fields = fieldEntries(m.annotations, ctx.emittedSpanIds, ctx.order);
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
  node.fields = fieldEntries(token.annotations, ctx.emittedSpanIds, ctx.order);
  const vocab = linkIndex.consume(token.id);
  if (vocab) node.vocab = vocab;
  // The archive records what is STORED. A word nobody has segmented shows a
  // morpheme that is not stored anywhere (derive synthesizes it, see
  // domain/virtualMorpheme.js) and holds nothing beyond the word: writing it
  // would put a synthetic id into a format whose ids are correlation keys, and
  // a round-trip would turn it into a real row that the source never had.
  // Importing the archive derives it again.
  node.morphemes = (token.morphemes || [])
    .filter((m) => !m.virtual)
    .map((m) => morphemeNode(m, linkIndex, ctx));
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
              ...orderOf(ctx.order, s.id),
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

/**
 * The document's share of `otherLayers` in project.json: the tokens and spans
 * on the token layers this app does not own, and the relations on every
 * relation layer, whichever span layer it hangs on. Each list names its layer
 * by id, which the manifest describes, and holds what the server holds (a
 * zero-width token stays one). Token layers come parents first, the order
 * their tokens can be made in. `ids` are what a comment can be anchored to.
 * `data` is null when the document holds none of it.
 */
function otherLayerData(layerInfo) {
  const tokenLayers = layerInfo.primaryTextLayer?.tokenLayers || [];
  const others = parentsFirst(otherTokenLayers(tokenLayers), (tl) => tl.parentTokenLayer);
  const tokens = [];
  const spans = [];
  const relations = [];
  const ids = { token: new Set(), span: new Set(), relation: new Set() };
  for (const tl of others) {
    if (!tl.tokens?.length) continue;
    tokens.push({
      layer: tl.id,
      tokens: tl.tokens.map((t) => {
        ids.token.add(t.id);
        const node = { id: t.id, begin: t.begin, end: t.end };
        if (t.precedence != null) node.precedence = t.precedence;
        return withMetadata(node, t.metadata);
      }),
    });
  }
  for (const sl of others.flatMap((tl) => tl.spanLayers || [])) {
    if (!sl.spans?.length) continue;
    spans.push({
      layer: sl.id,
      spans: sl.spans.map((s) => {
        ids.span.add(s.id);
        return withMetadata(
          { id: s.id, tokens: s.tokens || [], value: s.value ?? null },
          s.metadata,
        );
      }),
    });
  }
  for (const rl of tokenLayers.flatMap((tl) =>
    (tl.spanLayers || []).flatMap((sl) => sl.relationLayers || []),
  )) {
    if (!rl.relations?.length) continue;
    relations.push({
      layer: rl.id,
      relations: rl.relations.map((r) => {
        ids.relation.add(r.id);
        return withMetadata(
          { id: r.id, source: r.source, target: r.target, value: r.value ?? null },
          r.metadata,
        );
      }),
    });
  }
  const empty = !tokens.length && !spans.length && !relations.length;
  return { data: empty ? null : { tokens, spans, relations }, ids };
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
 * A comment outlives its anchor on the server, and a project can hold entities
 * this archive does not carry (whatever is on a text layer other than the
 * baseline), so a comment can be about something the file has no node for.
 * Such a comment is dropped here: a re-importer would have
 * nothing to hang it on, and the server refuses a comment on a missing anchor.
 * The caller counts what was dropped and warns once per file.
 *
 * `anchor.id` and `id` are correlation keys like every other id in the
 * archive. `author.name` is the display name AT EXPORT TIME — a label, since
 * display names change and the id is the identity. `anchorLabel` is the
 * caption the comment was posted with (what it is about, in words); it is
 * what a comment shows once its anchor is gone.
 */
function commentNodes(comments, archived = () => true) {
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
  const order = serverOrder(raw);
  const linkIndex = linkIndexFromRaw(raw, order);
  const ctx = { emittedTokenIds: new Set(), emittedSpanIds: new Set(), order };

  const sentences = (igtDoc.sortedSentences || []).map((s) => {
    ctx.emittedTokenIds.add(s.id);
    const node = withMetadata({ id: s.id, begin: s.begin, end: s.end }, s.sentenceToken?.metadata);
    node.fields = fieldEntries(s.annotations, ctx.emittedSpanIds, ctx.order);
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
  // The extras in the order the project holds them, so the file says the same
  // thing whichever way they were met, and an import that recreates them in
  // this order gives back the project it came from. Annotations go by layer
  // first: an import creates them a layer at a time (the bulk endpoint takes
  // one layer per call), so only the order WITHIN a layer survives, which is
  // also the only order that decides anything on screen.
  const byOrder = (a, b) => (a.order ?? Infinity) - (b.order ?? Infinity);
  const layerKey = (sp) => `${sp.layer?.scope}:${sp.layer?.name}`;
  extraSpans.sort((a, b) => layerKey(a).localeCompare(layerKey(b)) || byOrder(a, b));
  linkIndex.extras.sort(byOrder);
  const text = layerInfo.primaryTextLayer?.text;
  const other = otherLayerData(layerInfo);

  // What this file has a node for: the tree, the alignment, the sweep's
  // leftovers, and other apps' layers. A comment anchored anywhere else is
  // dropped (see commentNodes).
  const tokenIds = new Set([...ctx.emittedTokenIds, ...other.ids.token]);
  for (const t of orphanTokens) tokenIds.add(t.id);
  const spanIds = new Set([...ctx.emittedSpanIds, ...other.ids.span]);
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
      case 'relation':
        return other.ids.relation.has(id);
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
    ...(other.data ? { otherLayers: other.data } : {}),
    ...(nodes.length ? { comments: nodes } : {}),
  };
}
