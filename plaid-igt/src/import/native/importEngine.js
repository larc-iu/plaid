// Native archive import engine — rebuilds a project from a Plaid IGT JSON
// archive (docs/native-format.md), implementing the spec's re-import contract.
// Mirrors the FLEx engine's shape (../flex/importEngine.js): layer/vocab
// CREATION is the setup executor's job; this engine runs AFTER setup against
// the resolved project.
//
// Archive ids are correlation keys, never written: every created entity gets
// a fresh id and old→new maps thread references (vocab items ← links, tokens
// ← spans/links). Vocab items are created IN ARRAY ORDER — the archive
// contract that preserves the order entries spelled alike are numbered in.
//
// Other apps' layers ride along as plain Plaid data (./otherLayers.js): made
// once per project after setup, and filled per document once this app's own
// tokens and annotations exist.
//
// A metadata value that is exactly the archive id of a token, span, relation
// or document the archive carries is a reference to it, and is rewritten to
// the new id (./references.js).
//
// Resumability (same scheme as FLEx): a document is marked done
// (metadata.nativeImported) only after every write succeeded; on resume, done
// documents are skipped and half-imported ones are deleted and redone. Vocab
// items are deduped by metadata.nativeImportId (the archive item id, stamped
// at creation — it doubles as provenance back to the source archive).

import { documentProgress } from '../progress.js';
import { IMPORT_STAMP_KEYS, ImportCancelled, importStamp, priorImports } from '../resume.js';
import { CHUNK } from '../bulk.js';
import { metadataPatchTo } from '@/domain/metadataPatch';
import { attributedBody } from './commentAttribution.js';
import {
  hasOtherTokens,
  importOtherLayerData,
  noOtherLayers,
  restoreOtherLayers,
} from './otherLayers.js';
import {
  archivedIds,
  documentReferences,
  relinkDocumentReferences,
  rewriteReferences,
} from './references.js';
import {
  IGT_NAMESPACE,
  findBaselineTextLayer,
  findSentenceTokenLayer,
  findWordTokenLayer,
  findMorphemeTokenLayer,
  findAlignmentTokenLayer,
  readScope,
} from '../../domain/igtConfig.js';

const ITEM_SOURCE_KEY = 'nativeImportId';

/** The setup-wizard input derived from an archive manifest. */
export function deriveSetupData(manifest, projectName) {
  const schema = manifest.schema || {};
  const field = (scope) => (f) => ({
    name: f.name,
    scope,
    lang: f.lang ?? null,
    isCustom: true,
  });
  const fields = [
    ...(schema.fields?.sentence || []).map(field('Sentence')),
    ...(schema.fields?.word || []).map(field('Word')),
    ...(schema.fields?.morpheme || []).map(field('Morpheme')),
  ];
  const ignored = schema.ignoredTokens;
  return {
    basicInfo: { projectName },
    orthographies: {
      orthographies: [
        { name: 'Baseline', isBaseline: true },
        ...(schema.orthographies || []).map((o) => ({ name: o.name })),
      ],
    },
    fields: {
      fields,
      ignoredTokens:
        ignored == null
          ? undefined
          : ignored.type === 'blacklist'
            ? { mode: 'explicit', explicitIgnoredTokens: ignored.blacklist || [] }
            : {
                mode: 'unicode-punctuation',
                unicodePunctuationExceptions: ignored.whitelist || [],
              },
    },
    vocabulary: {
      vocabularies: (manifest.vocabularies || []).map((v) => ({
        id: `new-${v.id}`,
        name: v.name,
        enabled: true,
        isCustom: true,
      })),
    },
    documentMetadata: {
      enabledFields: (schema.documentMetadata || []).map((m) => ({
        name: m.name,
        enabled: true,
        isCustom: true,
      })),
    },
  };
}

/**
 * Resolve engine write targets from a set-up project. Throws when a layer or
 * field the archive needs is missing (setup incomplete).
 */
export function resolveNativeTargets(project, manifest) {
  const textLayer = findBaselineTextLayer(project.textLayers || []);
  if (!textLayer) throw new Error('No baseline text layer. Project setup incomplete');
  const tokenLayers = textLayer.tokenLayers || [];
  const sentenceLayer = findSentenceTokenLayer(tokenLayers);
  const wordLayer = findWordTokenLayer(tokenLayers);
  const morphemeLayer = findMorphemeTokenLayer(tokenLayers);
  const alignmentLayer = findAlignmentTokenLayer(tokenLayers);
  if (!sentenceLayer || !wordLayer || !morphemeLayer) {
    throw new Error('Substrate token layers missing. Project setup incomplete');
  }
  const spanLayerByScopeName = new Map();
  for (const tl of tokenLayers) {
    for (const sl of tl.spanLayers || []) {
      spanLayerByScopeName.set(`${readScope(sl.config)}:${sl.name}`, sl.id);
    }
  }
  const schema = manifest.schema || {};
  for (const [scopeKey, scope] of [
    ['sentence', 'Sentence'],
    ['word', 'Word'],
    ['morpheme', 'Morpheme'],
  ]) {
    for (const f of schema.fields?.[scopeKey] || []) {
      if (!spanLayerByScopeName.has(`${scope}:${f.name}`)) {
        throw new Error(
          `Annotation field "${f.name}" (${scope}) missing. Project setup incomplete`,
        );
      }
    }
  }
  return {
    textLayerId: textLayer.id,
    sentenceLayerId: sentenceLayer.id,
    wordLayerId: wordLayer.id,
    morphemeLayerId: morphemeLayer.id,
    alignmentLayerId: alignmentLayer?.id ?? null,
    spanLayerByScopeName,
    // Span layers with no scope, made as the documents that need them arrive.
    unscopedSpanLayers: new Map(),
    // Other apps' layers, filled in by restoreOtherLayers once per project.
    otherLayers: noOtherLayers(),
  };
}

/**
 * Import one vocabulary's items IN ARRAY ORDER (the entry-numbering
 * contract). Returns Map<archiveItemId, newItemId>. Resume-safe: items
 * already stamped with a matching nativeImportId are reused.
 */
export async function importVocabulary({
  client,
  vocabId,
  vocabData,
  onProgress,
  shouldStop,
  warnings = [],
}) {
  const check = () => {
    if (shouldStop?.()) throw new ImportCancelled();
  };

  // Field schema first, so the editor renders the columns from the start. A
  // field's `tagset` names one of the vocabulary's own tagsets, written next;
  // `lang` is a FLEx custom field's writing system, read back by the LIFT
  // export. Both only when the archive has them.
  if (vocabData.fields?.length) {
    await client.vocabLayers.setConfig(
      vocabId,
      IGT_NAMESPACE,
      'fields',
      Object.fromEntries(
        vocabData.fields.map((f) => [
          f.name,
          {
            inline: !!f.inline,
            ...(f.tagset ? { tagset: f.tagset } : {}),
            ...(f.lang ? { lang: f.lang } : {}),
            ...(f.type === 'item' ? { type: 'item' } : {}),
            ...(f.type === 'item' && f.many ? { many: true } : {}),
            ...(f.scope === 'entry' ? { scope: 'entry' } : {}),
          },
        ]),
      ),
    );
  }
  // The tagsets go in whole, like the fields: setup seeds a Status list for
  // the Status field it seeds, and an archive whose fields replaced that
  // field must not leave its list behind governing nothing.
  if (vocabData.tagsets && Object.keys(vocabData.tagsets).length) {
    await client.vocabLayers.setConfig(vocabId, IGT_NAMESPACE, 'tagsets', vocabData.tagsets);
  } else if (vocabData.fields?.length) {
    await client.vocabLayers.deleteConfig(vocabId, IGT_NAMESPACE, 'tagsets');
  }
  // Other apps' namespaces, verbatim (plaid-dict's publication record).
  for (const [ns, keys] of Object.entries(vocabData.config || {})) {
    if (ns === IGT_NAMESPACE || !keys || typeof keys !== 'object') continue;
    for (const [key, value] of Object.entries(keys)) {
      await client.vocabLayers.setConfig(vocabId, ns, key, value);
    }
  }

  const existing = await client.vocabLayers.get(vocabId, true);
  const itemIdMap = new Map();
  for (const item of existing.items || []) {
    const source = item.metadata?.[ITEM_SOURCE_KEY];
    if (source) itemIdMap.set(source, item.id);
  }

  const pending = (vocabData.items || []).filter((it) => !itemIdMap.has(it.id));
  let done = 0;
  for (let i = 0; i < pending.length; i += CHUNK) {
    check();
    const chunk = pending.slice(i, i + CHUNK);
    // bulkCreate rather than a batch of per-item creates: one request, one
    // operation row, one pass over the table, where a batch re-dispatches the
    // whole REST stack per item inside the same held write lock. `ids` come
    // back in input order.
    const { ids } = await client.vocabItems.bulkCreate(
      chunk.map((it) => ({
        vocabLayerId: vocabId,
        form: it.form,
        metadata: { ...(it.metadata || {}), [ITEM_SOURCE_KEY]: it.id },
      })),
    );
    chunk.forEach((it, j) => {
      if (ids[j]) itemIdMap.set(it.id, ids[j]);
    });
    done += chunk.length;
    onProgress?.({ phase: 'vocabulary', name: vocabData.name, done, total: pending.length });
  }

  // Entry comments. Items are reused on resume, so the comments on them may
  // already have been posted by the run that made them: a comment already on
  // the vocabulary with the same anchor and body is not posted again.
  const comments = vocabData.comments || [];
  if (comments.length > 0) {
    check();
    const posted = new Set();
    for (const c of await client.comments.listInVocab(vocabId)) {
      posted.add(commentKey(c.entityId, c.body));
    }
    await postArchivedComments({
      client,
      name: vocabData.name,
      comments,
      anchorFor: (anchor) => (anchor?.type === 'vocab-item' ? itemIdMap.get(anchor.id) : null),
      alreadyPosted: (entityId, body) => posted.has(commentKey(entityId, body)),
      warnings,
      check,
    });
  }
  return itemIdMap;
}

const commentKey = (entityId, body) => `${entityId}\u0000${body}`;

/**
 * Post an archive's comments against the entities this import created.
 * Posted one at a time (there is no bulk comment endpoint) inside a batch.
 *
 * Anchors resolve through the same old→new maps the annotations used. What
 * cannot be preserved is authorship: the server stamps author and timestamps
 * from the caller and the clock, so every imported comment belongs to whoever
 * ran the import, and the original attribution survives only as the note
 * `attributedBody` puts at the top of the body.
 */
async function postArchivedComments({
  client,
  name,
  comments,
  anchorFor,
  alreadyPosted = () => false,
  warnings,
  check,
}) {
  let unattributed = 0;
  const posts = [];
  for (const c of comments) {
    const entityId = anchorFor(c.anchor);
    if (!entityId) {
      warnings.push(
        `"${name}": comment ${c.id} skipped (its ${anchorNoun(c.anchor?.type)} did not survive the import)`,
      );
      continue;
    }
    const { body: text, attributed } = attributedBody(c);
    if (!attributed) unattributed += 1;
    if (alreadyPosted(entityId, text)) continue;
    posts.push({
      entityType: c.anchor.type,
      entityId,
      body: text,
      anchorLabel: c.anchorLabel ?? null,
    });
  }
  if (unattributed > 0) {
    warnings.push(
      `"${name}": ${unattributed} comment(s) were too long to carry their original attribution, so they were imported unchanged.`,
    );
  }
  for (let i = 0; i < posts.length; i += CHUNK) {
    check();
    await client.batched(async (b) => {
      for (const post of posts.slice(i, i + CHUNK)) {
        b.comments.create(
          post.entityType,
          post.entityId,
          post.body,
          post.anchorLabel ? { anchorLabel: post.anchorLabel } : {},
        );
      }
    });
  }
}

const anchorNoun = (type) => (type === 'vocab-item' ? 'entry' : (type ?? 'anchor'));

// Reconstitute token metadata from a word node: stored metadata ∪ the lifted
// orthography values (unset orthographies stay unset).
const wordMetadata = (node) => {
  const metadata = { ...(node.metadata || {}) };
  for (const [name, value] of Object.entries(node.orthographies || {})) {
    metadata[`orthog:${name}`] = value;
  }
  return metadata;
};

// Morpheme node → stored metadata ∪ {form?, morphType?} (present-vs-absent
// preserved: only keys the archive carries are written back).
const morphemeMetadata = (node) => ({
  ...(node.metadata || {}),
  ...('form' in node ? { form: node.form } : {}),
  ...('morphType' in node ? { morphType: node.morphType } : {}),
});

const maybeMetadata = (metadata) => (Object.keys(metadata).length ? { metadata } : {});
// The steps one document goes through, in order, so progress can report how
// far into a document it is and not just which document.
const DOCUMENT_STEPS = [
  'Creating document',
  'Creating text',
  'Creating sentences',
  'Creating words',
  'Creating morphemes',
  'Creating segments',
  'Creating annotations',
  "Creating other apps' annotation",
  'Linking lexicon',
  'Restoring comments',
  'Uploading media',
];

/** Import one document end to end. Assumes it does not exist yet. */
async function importNativeDocument({
  client,
  projectId,
  targets,
  docData,
  itemIdMap,
  mediaBytes,
  mediaName,
  index = 0,
  total = 1,
  onProgress,
  shouldStop,
  warnings = [],
  // Optional: archive document id -> {docId, tokenIdMap}, filled in for the
  // runner, which relinks the vocabularies' examples once every document is in.
  docMaps = null,
  // Archive document id -> the project's document, for every document that is
  // finished: what a reference to a document resolves through.
  docIdMap = new Map(),
}) {
  const progress = documentProgress({
    onProgress,
    doc: docData.name,
    index,
    total,
    steps: DOCUMENT_STEPS,
  });
  const check = () => {
    if (shouldStop?.()) throw new ImportCancelled();
  };

  progress('Creating document');
  const newDoc = await client.documents.create(
    projectId,
    docData.name,
    importStamp(
      rewriteReferences(docData.metadata, (id) => docIdMap.get(id)),
      docData.id,
    ),
  );
  const docId = newDoc.id ?? newDoc;

  const body = docData.baseline?.body ?? '';
  const tokenIdMap = new Map(); // archive token id → new token id
  if (docMaps && docData.id != null) docMaps.set(docData.id, { docId, tokenIdMap });
  const spanIdMap = new Map(); // archive span id → new span id
  const relationIdMap = new Map(); // archive relation id → new relation id
  const tokenLayerOf = new Map(); // new token id → the token layer it is in
  let baselineTextId = null; // for comments anchored to the text itself
  // References in metadata, resolved through everything made so far. This
  // document's own id is known from here on.
  const lookup = (id) =>
    tokenIdMap.get(id) ??
    spanIdMap.get(id) ??
    relationIdMap.get(id) ??
    (id === docData.id ? docId : docIdMap.get(id));
  const refs = documentReferences({ client, lookup, ahead: archivedIds(docData), check });

  if (body.length > 0) {
    progress('Creating text');
    const textMetadata = refs.prepare(docData.baseline?.metadata || {});
    const text = await client.texts.create(targets.textLayerId, docId, body, textMetadata.metadata);
    const textId = text.id ?? text;
    baselineTextId = textId;
    if (textMetadata.later) refs.remember('text', textId, textMetadata.metadata);

    const bulkTokens = async (specs, oldIds) => {
      if (!specs.length) return;
      const ids = await refs.create(
        'token',
        specs,
        async (sent) => (await client.tokens.bulkCreate(sent))?.ids,
      );
      oldIds.forEach((oldId, i) => {
        if (oldId != null && ids[i]) tokenIdMap.set(oldId, ids[i]);
      });
      // Which layer each new token is in, so a span layer the archive names
      // but setup did not make can be created where its tokens are.
      specs.forEach((spec, i) => {
        if (ids[i]) tokenLayerOf.set(ids[i], spec.tokenLayerId);
      });
    };

    const sentences = docData.sentences || [];
    const words = sentences.flatMap((s) => s.words || []);
    const orphansBy = (layer) => (docData.orphanTokens || []).filter((t) => t.layer === layer);

    // Sentence partition (bulk; partitioning layers require it). Orphan
    // sentence tokens ride in the same call — same layer, and partitioning
    // rejects later singles.
    check();
    progress('Creating sentences');
    const sentenceNodes = [...sentences, ...orphansBy('sentence')];
    await bulkTokens(
      sentenceNodes.map((s) => ({
        tokenLayerId: targets.sentenceLayerId,
        text: textId,
        begin: s.begin,
        end: s.end,
        ...maybeMetadata({ ...(s.metadata || {}) }),
      })),
      sentenceNodes.map((s) => s.id),
    );

    check();
    progress('Creating words');
    const wordNodes = [
      ...words.map((w) => ({ spec: wordMetadata(w), node: w })),
      ...orphansBy('word').map((t) => ({ spec: { ...(t.metadata || {}) }, node: t })),
    ];
    await bulkTokens(
      wordNodes.map(({ spec, node }) => ({
        tokenLayerId: targets.wordLayerId,
        text: textId,
        begin: node.begin,
        end: node.end,
        ...maybeMetadata(spec),
      })),
      wordNodes.map(({ node }) => node.id),
    );

    check();
    progress('Creating morphemes');
    const morphemeNodes = [
      ...words
        .flatMap((w) => w.morphemes || [])
        .map((m) => ({ spec: morphemeMetadata(m), node: m })),
      ...orphansBy('morpheme').map((t) => ({ spec: { ...(t.metadata || {}) }, node: t })),
    ];
    await bulkTokens(
      morphemeNodes.map(({ spec, node }) => ({
        tokenLayerId: targets.morphemeLayerId,
        text: textId,
        begin: node.begin,
        end: node.end,
        precedence: node.precedence ?? 1,
        ...maybeMetadata(spec),
      })),
      morphemeNodes.map(({ node }) => node.id),
    );

    // Time alignment, with times folded back into metadata.
    const alignment = docData.alignment || [];
    if (alignment.length) {
      check();
      if (targets.alignmentLayerId) {
        progress('Creating segments');
        await bulkTokens(
          alignment.map((a) => ({
            tokenLayerId: targets.alignmentLayerId,
            text: textId,
            begin: a.begin,
            end: a.end,
            metadata: { timeBegin: a.timeBegin, timeEnd: a.timeEnd, ...(a.metadata || {}) },
          })),
          alignment.map((a) => a.id),
        );
      } else {
        warnings.push(
          `"${docData.name}": ${alignment.length} time alignment(s) skipped because there is no alignment layer`,
        );
      }
    }

    // Annotation spans: gather field entries across the tree, DEDUPED BY SPAN
    // ID (entries sharing an id denote one span over the union of tokens),
    // then the extraSpans section. Token references map old → new. An
    // extraSpans record sharing an id with a tree field entry is AUTHORITATIVE
    // (per the spec): it carries the span's full token list — e.g. a span
    // reaching an orphan token — so the tree entries for that id are skipped.
    check();
    progress('Creating annotations');
    const authoritativeExtraIds = new Set(
      (docData.extraSpans || []).map((s) => s.id).filter((id) => id != null),
    );
    const spansById = new Map();
    const addEntry = (scope, fieldName, entry, oldTokenId) => {
      if (!entry || authoritativeExtraIds.has(entry.id)) return;
      const key = entry.id ?? `${scope}:${fieldName}:${oldTokenId}`;
      let agg = spansById.get(key);
      if (!agg) {
        agg = {
          id: entry.id ?? null,
          order: entry.order ?? null,
          scope,
          fieldName,
          layerKey: `${scope}:${fieldName}`,
          tokens: [],
          value: entry.value ?? null,
          metadata: entry.metadata,
        };
        spansById.set(key, agg);
      }
      agg.tokens.push(oldTokenId);
    };
    for (const s of sentences) {
      for (const [name, entry] of Object.entries(s.fields || {}))
        addEntry('Sentence', name, entry, s.id);
      for (const w of s.words || []) {
        for (const [name, entry] of Object.entries(w.fields || {}))
          addEntry('Word', name, entry, w.id);
        for (const m of w.morphemes || []) {
          for (const [name, entry] of Object.entries(m.fields || {}))
            addEntry('Morpheme', name, entry, m.id);
        }
      }
    }
    // `archiveId` is carried alongside each spec purely so comments anchored to
    // a span can be reattached after the bulk create returns its new ids. It is
    // null for a tree entry that had no id of its own.
    const spanSpecs = [];
    // A span layer with no IGT scope: another app's, or one a service put on
    // the segments. Setup never makes one, since it builds fields from the
    // archive's scoped field schema, so it is made here on the token layer its
    // annotations point into, under the name it had. Kept across documents, so
    // a corpus does not end up with one layer of that name per document.
    const ensureSpanLayer = async (scope, name, tokenIds, archiveLayerId = null) => {
      // One the archive describes was made up front, and is found by its own
      // id rather than by name, since two layers may share a name.
      const restored =
        archiveLayerId == null ? null : targets.otherLayers.spanLayers.get(archiveLayerId);
      if (restored) return restored;
      const known = targets.spanLayerByScopeName.get(`${scope}:${name}`);
      if (known) return known;
      const tokenLayerId = tokenLayerOf.get(tokenIds[0]);
      if (scope || !name || !tokenLayerId) return null;
      const cacheKey = `${tokenLayerId}:${name}`;
      if (!targets.unscopedSpanLayers.has(cacheKey)) {
        const made = await client.spanLayers.create(tokenLayerId, name);
        targets.unscopedSpanLayers.set(cacheKey, made.id ?? made);
      }
      return targets.unscopedSpanLayers.get(cacheKey);
    };
    const resolveSpan = async (
      scope,
      name,
      tokens,
      value,
      metadata,
      label,
      archiveId = null,
      order = null,
      archiveLayerId = null,
    ) => {
      const tokenIds = tokens.map((t) => tokenIdMap.get(t)).filter(Boolean);
      const spanLayerId =
        tokenIds.length === tokens.length
          ? await ensureSpanLayer(scope, name, tokenIds, archiveLayerId)
          : null;
      if (!spanLayerId || tokenIds.length !== tokens.length) {
        warnings.push(
          `"${docData.name}": annotation ${label} skipped (unresolvable ${!spanLayerId ? 'layer' : 'tokens'})`,
        );
        return;
      }
      spanSpecs.push({
        spanLayerId,
        tokens: tokenIds,
        value,
        ...(metadata ? { metadata } : {}),
        archiveId,
        order,
      });
    };
    for (const agg of spansById.values()) {
      // A tree entry that carried its own span id correlates back; one keyed
      // by scope:field:token was synthesized here and has no archive id.
      const [scope, name] = [agg.scope, agg.fieldName];
      await resolveSpan(
        scope,
        name,
        agg.tokens,
        agg.value,
        agg.metadata,
        agg.layerKey,
        agg.id,
        agg.order,
      );
    }
    for (const extra of docData.extraSpans || []) {
      await resolveSpan(
        extra.layer?.scope ?? null,
        extra.layer?.name,
        extra.tokens || [],
        extra.value ?? null,
        extra.metadata,
        `${extra.layer?.name} (extra)`,
        extra.id ?? null,
        extra.order ?? null,
        extra.layer?.id ?? null,
      );
    }
    // Created in the order the archive says the project held them, so the one
    // the editor shows among several on a token is the one it showed there.
    // Server order is insertion order, which is the order of these calls.
    spanSpecs.sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity));
    // The bulk endpoint requires all spans in one call to share a layer.
    const byLayer = new Map();
    for (const s of spanSpecs) {
      if (!byLayer.has(s.spanLayerId)) byLayer.set(s.spanLayerId, []);
      byLayer.get(s.spanLayerId).push(s);
    }
    for (const specs of byLayer.values()) {
      for (let i = 0; i < specs.length; i += CHUNK) {
        check();
        const chunk = specs.slice(i, i + CHUNK);
        const ids = await refs.create(
          'span',
          chunk.map(({ archiveId: _archiveId, ...spec }) => spec),
          async (sent) => (await client.spans.bulkCreate(sent))?.ids,
        );
        chunk.forEach((spec, j) => {
          if (spec.archiveId != null && ids?.[j]) spanIdMap.set(spec.archiveId, ids[j]);
        });
      }
    }

    // Other apps' tokens, annotations and relations, now that every token and
    // annotation of this app's that a relation may join exists. Before the
    // lexicon links, since a link may be on one of those tokens.
    if (docData.otherLayers) {
      check();
      progress("Creating other apps' annotation");
      await importOtherLayerData({
        client,
        docData,
        textId,
        restored: targets.otherLayers,
        tokenIdMap,
        spanIdMap,
        relationIdMap,
        refs,
        warnings,
        check,
      });
    }

    // Vocab links: inline refs from the tree + the extras section. Link
    // metadata (provenance) rides verbatim.
    progress('Linking lexicon');
    const linkSpecs = [];
    const addLink = (ref, oldTokenIds, label) => {
      if (!ref) return;
      const order = ref.order ?? null;
      const itemId = itemIdMap.get(ref.itemId);
      const tokenIds = oldTokenIds.map((t) => tokenIdMap.get(t)).filter(Boolean);
      if (!itemId || tokenIds.length !== oldTokenIds.length) {
        warnings.push(
          `"${docData.name}": vocab link ${label} skipped (unresolvable ${!itemId ? 'item' : 'tokens'})`,
        );
        return;
      }
      linkSpecs.push({ itemId, tokenIds, metadata: ref.metadata, order });
    };
    for (const s of sentences) {
      for (const w of s.words || []) {
        addLink(w.vocab, [w.id], `on word ${w.id}`);
        for (const m of w.morphemes || []) addLink(m.vocab, [m.id], `on morpheme ${m.id}`);
      }
    }
    for (const extra of docData.extraVocabLinks || []) {
      addLink(extra, extra.tokens || [], extra.id);
    }
    // Same as the spans: among two links on one token the editor shows the
    // last, so the order they are made in is what a person sees.
    linkSpecs.sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity));
    for (let i = 0; i < linkSpecs.length; i += CHUNK) {
      check();
      await refs.create(
        'link',
        linkSpecs
          .slice(i, i + CHUNK)
          .map((l) => ({ vocabItem: l.itemId, tokens: l.tokenIds, metadata: l.metadata })),
        async (sent) => (await client.vocabLinks.bulkCreate(sent))?.ids,
      );
    }
  } else if (hasOtherTokens(docData)) {
    // Tokens need a text to sit on, and a document with an empty baseline gets
    // none.
    warnings.push(`"${docData.name}": tokens from another app skipped (the document has no text)`);
  }

  // What names something this document made after it, now that all of it
  // exists. Before the done marker, so an interrupted import redoes it too.
  await refs.settle();

  // Comments, BEFORE the done marker so an interrupted import redoes them
  // along with everything else rather than leaving a document half-commented.
  const comments = docData.comments || [];
  if (comments.length > 0) {
    check();
    progress('Restoring comments');
    await postArchivedComments({
      client,
      name: docData.name,
      comments,
      anchorFor: (anchor) => {
        switch (anchor?.type) {
          case 'document':
            return docId;
          case 'text':
            return baselineTextId;
          case 'token':
            return tokenIdMap.get(anchor.id);
          case 'span':
            return spanIdMap.get(anchor.id);
          case 'relation':
            return relationIdMap.get(anchor.id);
          default:
            return null;
        }
      },
      warnings,
      check,
    });
  }

  // Media, from the archive bytes.
  let mediaFailed = false;
  if (mediaBytes) {
    check();
    progress('Uploading media');
    try {
      await client.documents.uploadMedia(docId, new File([mediaBytes], mediaName || 'media'));
    } catch (err) {
      mediaFailed = true;
      warnings.push(
        `"${docData.name}": media upload failed. Document left unfinished so re-importing retries it: ${err?.message ?? err}`,
      );
    }
  }

  // Mark complete LAST — resume treats unmarked documents as partial. If the
  // media upload failed, deliberately leave the document UNMARKED so a re-import
  // deletes-and-redoes it (recovering the media) instead of silently marking it
  // done and losing the media forever.
  //
  // The metadata goes again whole, now that what it names in the document
  // itself exists. From here on another document's reference to it resolves.
  if (!mediaFailed) {
    await client.documents.setMetadata(
      docId,
      importStamp(rewriteReferences(docData.metadata, lookup), docData.id, true),
    );
    if (docData.id != null) docIdMap.set(docData.id, docId);
  }
  return docId;
}

/**
 * Run a full archive import against a set-up project. Skips documents already
 * marked imported; deletes and redoes half-imported ones. Returns
 * { imported, skipped, redone, warnings }.
 */
// The whole import is ONE logical operation in the audit log (vocabulary +
// every document); each write keeps its own description underneath. Resumable
// retries start a fresh operation, which is the honest reading of the log.
export async function runNativeImport(args) {
  return args.client.withOperation('Import Plaid IGT archive', () => runNativeImportImpl(args));
}

async function runNativeImportImpl({ client, projectId, archive, onProgress, shouldStop }) {
  const project = await client.projects.get(projectId);
  const targets = resolveNativeTargets(project, archive.manifest);
  const warnings = [];

  // Stored app config the setup wizard doesn't cover, written verbatim. The
  // wizard does create documentMetadata, but only as `{name}` rows, so the
  // archive's version is written over it to bring each field's tagset back.
  const schema = archive.manifest.schema || {};
  for (const [key, value] of [
    ['autoAnalysis', schema.autoAnalysis],
    ['tagsets', schema.tagsets],
    ['languages', schema.languages],
    ['speakers', schema.speakers],
    ['serviceDefaults', schema.serviceDefaults],
    ['compose', schema.compose],
    ['export', schema.exportPresets],
    ['documentMetadata', schema.documentMetadata],
  ]) {
    if (value != null) await client.projects.setConfig(projectId, IGT_NAMESPACE, key, value);
  }

  // The project's annotation manual. Nothing in the archive points at a
  // guideline (it is addressed by title, not by id), so there is no id map to
  // keep and one already in the project is one this import wrote before it was
  // interrupted: a resume asks what is there and writes the rest, rather than
  // laying down a second copy of the manual. Title and body together say which
  // is which, since a project may hold two guidelines of one title.
  // A failure here warns instead of stopping the import: an annotation manual
  // is worth having and is not worth losing a corpus over.
  const wanted = (archive.manifest.guidelines || []).filter((g) => g?.title);
  if (wanted.length) {
    // Counted, not matched as a set: an archive holding the same guideline
    // twice means two, and one already in the project answers for one of
    // them. Matching by set alone lost the second copy.
    const key = (g) => `${g.title}\u0000${g.body || ''}`;
    const have = new Map();
    try {
      const existing = await client.guidelines.list(projectId, { includeBodies: true });
      existing.forEach((g) => have.set(key(g), (have.get(key(g)) || 0) + 1));
    } catch (err) {
      warnings.push(`The project's guidelines could not be read: ${err?.message ?? err}`);
    }
    for (const g of wanted) {
      const left = have.get(key(g)) || 0;
      if (left > 0) {
        have.set(key(g), left - 1);
        continue;
      }
      try {
        await client.guidelines.create(projectId, g.title, {
          body: g.body || '',
          pinned: !!g.pinned,
        });
      } catch (err) {
        warnings.push(`Guideline "${g.title}" could not be created: ${err?.message ?? err}`);
      }
    }
  }

  // Point each field back at its tagset. Setup created the fields; the
  // reference lives on the span layer, which the wizard knows nothing about.
  const spanLayerByScopeName = new Map();
  for (const tl of findBaselineTextLayer(project.textLayers || [])?.tokenLayers || []) {
    for (const sl of tl.spanLayers || []) {
      spanLayerByScopeName.set(`${readScope(sl.config)}:${sl.name}`, sl);
    }
  }
  for (const [scopeKey, scope] of [
    ['sentence', 'Sentence'],
    ['word', 'Word'],
    ['morpheme', 'Morpheme'],
  ]) {
    for (const field of schema.fields?.[scopeKey] || []) {
      if (!field.tagset) continue;
      const layer = spanLayerByScopeName.get(`${scope}:${field.name}`);
      if (!layer) continue;
      await client.spanLayers.setConfig(layer.id, IGT_NAMESPACE, 'tagset', field.tagset);
    }
  }

  // Other apps' settings and layers, once for the whole project, before any
  // document needs them.
  targets.otherLayers = await restoreOtherLayers({
    client,
    projectId,
    project,
    manifest: archive.manifest,
    warnings,
    check: () => {
      if (shouldStop?.()) throw new ImportCancelled();
    },
  });

  // Vocabularies: archive vocab → the same-named project vocab created by
  // setup. Item maps merge (item ids are unique across vocabularies).
  const projectVocabs = project.vocabs || [];
  const itemIdMap = new Map();
  for (const vocab of archive.vocabularies) {
    if (shouldStop?.()) throw new ImportCancelled();
    const target = projectVocabs.find((v) => v.name === vocab.name);
    if (!target) {
      warnings.push(
        `Vocabulary "${vocab.name}" has no same-named target in the project. Items skipped`,
      );
      continue;
    }
    const map = await importVocabulary({
      client,
      vocabId: target.id,
      vocabData: vocab.data,
      onProgress,
      shouldStop,
      warnings,
    });
    for (const [oldId, newId] of map) itemIdMap.set(oldId, newId);
  }

  // Resume bookkeeping: what an earlier run made, by archive document id.
  const prior = await priorImports(client, projectId);

  const docMaps = new Map(); // archive document id → {docId, tokenIdMap}
  // The documents a promoted example points into. A resume skips a document an
  // earlier run finished, and the last pass would then have no map for it and
  // would drop those examples, so the map is rebuilt for these.
  const cited = new Set();
  for (const vocab of archive.vocabularies) {
    for (const it of vocab.data?.items || []) {
      for (const ex of it.metadata?.examples || []) {
        if (ex && typeof ex.document === 'string') cited.add(ex.document);
      }
    }
  }
  const results = { imported: 0, skipped: 0, redone: 0 };
  // The documents a reference can already be resolved to: those an earlier
  // run finished. Each one this run finishes joins them.
  const docIdMap = new Map();
  for (const doc of archive.documents) {
    const existing = prior.find(doc.data?.id);
    if (existing && prior.done(existing)) docIdMap.set(doc.data.id, existing.id);
  }
  for (let i = 0; i < archive.documents.length; i += 1) {
    if (shouldStop?.()) throw new ImportCancelled();
    const doc = archive.documents[i];
    onProgress?.({
      phase: 'document',
      doc: doc.name,
      index: i,
      total: archive.documents.length,
      step: 'Starting',
    });
    const existing = prior.find(doc.data?.id);
    if (existing && prior.done(existing)) {
      results.skipped += 1;
      if (cited.has(doc.data?.id)) {
        const tokenIdMap = await rebuildTokenMap({
          client,
          docId: existing.id,
          docData: doc.data,
          targets,
        });
        docMaps.set(doc.data.id, { docId: existing.id, tokenIdMap });
      }
      continue;
    }
    if (existing) {
      await client.documents.delete(existing.id); // half-imported: redo cleanly
      results.redone += 1;
    }
    await importNativeDocument({
      client,
      projectId,
      targets,
      docData: doc.data,
      itemIdMap,
      docMaps,
      docIdMap,
      mediaBytes: doc.mediaBytes,
      mediaName: doc.mediaFile ? doc.mediaFile.split('/').at(-1) : null,
      index: i,
      total: archive.documents.length,
      onProgress,
      shouldStop,
      warnings,
    });
    results.imported += 1;
  }
  // What names a document made after the one naming it, now that every
  // document is in. Idempotent, so a resume redoes it harmlessly.
  await relinkDocumentReferences({
    client,
    documents: archive.documents.map((d) => d.data),
    docIdMap,
    stampKeys: new Set(IMPORT_STAMP_KEYS),
    check: () => {
      if (shouldStop?.()) throw new ImportCancelled();
    },
  });

  // Last: the structure a vocabulary keeps in item metadata (parents, Entry
  // fields, examples) names ids from the archive, so it is
  // rewritten through the maps now that every item, document and token
  // exists. Idempotent, so a resume redoes it harmlessly.
  for (const vocab of archive.vocabularies) {
    if (shouldStop?.()) throw new ImportCancelled();
    await relinkVocabStructure({
      client,
      vocabData: vocab.data,
      itemIdMap,
      docMaps,
      docIdMap,
      warnings,
      shouldStop,
    });
  }
  onProgress?.({ phase: 'done', ...results });
  return { ...results, warnings };
}

/**
 * The archive-to-server token map for a document an earlier run finished, so a
 * resume can still rewrite the examples that point into it. Tokens are matched
 * on what they ARE rather than on the order they were created in: a sentence
 * or a word by its extent, a morpheme by its extent and its place in the word.
 * Only what an example can point at is mapped.
 */
export async function rebuildTokenMap({ client, docId, docData, targets }) {
  const raw = await client.documents.get(docId, true);
  const byKey = new Map();
  const kindOf = (tl) => {
    if (tl.id === targets.wordLayerId) return 'w';
    if (tl.id === targets.morphemeLayerId) return 'm';
    if (tl.id === targets.sentenceLayerId) return 's';
    return null;
  };
  for (const tl of (raw.textLayers || []).flatMap((t) => t.tokenLayers || [])) {
    const kind = kindOf(tl);
    if (!kind) continue;
    for (const t of tl.tokens || []) {
      const key =
        kind === 'm' ? `m:${t.begin}:${t.end}:${t.precedence ?? 1}` : `${kind}:${t.begin}:${t.end}`;
      if (!byKey.has(key)) byKey.set(key, t.id);
    }
  }
  const map = new Map();
  for (const s of docData.sentences || []) {
    // An example may cite a whole sentence, so sentence tokens are mapped too.
    const sentenceId = byKey.get(`s:${s.begin}:${s.end}`);
    if (sentenceId) map.set(s.id, sentenceId);
    for (const w of s.words || []) {
      const wordId = byKey.get(`w:${w.begin}:${w.end}`);
      if (wordId) map.set(w.id, wordId);
      for (const m of w.morphemes || []) {
        const morphId = byKey.get(`m:${m.begin}:${m.end}:${m.precedence ?? 1}`);
        if (morphId) map.set(m.id, morphId);
      }
    }
  }
  return map;
}

/**
 * The item metadata that refers to other things, as `[{id, metadata}]` bulk-
 * update entries with every reference mapped onto the ids the import made:
 * `parent`, each Entry-typed field, and the `examples` list's {document, token}
 * pairs. A reference to something that did not survive is dropped, and said.
 *
 * `metadata` is a PATCH against the map the item was created with (the
 * archive's, plus this run's stamp — see the create above), so a reference that
 * did not survive comes out as an explicit null, which is how a key is deleted.
 * It used to be the whole map, written with a PUT. The patch is also what lets a
 * resume run over items an earlier run already relinked: setting a key to what
 * it holds and nulling one already gone are both no-ops, and a key somebody has
 * added by hand since is no longer swept away with them.
 */
export function planVocabRelink(vocabData, itemIdMap, docMaps, docIdMap = null) {
  const refFields = (vocabData.fields || []).filter((f) => f.type === 'item');
  // Any other value naming an entry or a document by its archive id is a
  // reference too (./references.js). The import's own stamp names the archive
  // entry on purpose, and is written afresh below anyway.
  const lookup = (id) => itemIdMap.get(id) ?? docIdMap?.get(id);
  const stamp = new Set([ITEM_SOURCE_KEY]);
  const out = [];
  const dropped = [];
  for (const it of vocabData.items || []) {
    const newId = itemIdMap.get(it.id);
    const meta = it.metadata;
    if (!newId || !meta) continue;
    let next = { ...meta };
    let changed = false;
    if (typeof meta.parent === 'string') {
      const p = itemIdMap.get(meta.parent);
      if (p) next.parent = p;
      else {
        delete next.parent;
        delete next.senseOrder;
        dropped.push(`${it.form}: parent`);
      }
      changed = true;
    }
    for (const f of refFields) {
      const v = meta[f.name];
      if (v == null) continue;
      const ids = (Array.isArray(v) ? v : [v]).filter((x) => typeof x === 'string');
      const mapped = ids.map((x) => itemIdMap.get(x)).filter(Boolean);
      if (mapped.length !== ids.length) dropped.push(`${it.form}: ${f.name}`);
      if (mapped.length) next[f.name] = f.many ? mapped : mapped[0];
      else delete next[f.name];
      changed = true;
    }
    if (Array.isArray(meta.examples)) {
      const kept = [];
      for (const ex of meta.examples) {
        if (!ex || typeof ex.document !== 'string') {
          kept.push(ex);
          continue;
        }
        const doc = docMaps?.get(ex.document);
        const token = doc?.tokenIdMap.get(ex.token);
        if (doc && token) kept.push({ ...ex, document: doc.docId, token });
        else dropped.push(`${it.form}: example`);
      }
      if (kept.length) next.examples = kept;
      else delete next.examples;
      changed = true;
    }
    const rewritten = rewriteReferences(next, lookup, stamp);
    if (rewritten !== next) {
      next = rewritten;
      changed = true;
    }
    // `meta` is the ARCHIVE's copy, which carries no stamp of this run (and may
    // carry the stale one of the run that produced the archive), while the item
    // was created with that copy plus this run's stamp. Both sides carry the
    // stamp, so the diff never touches it and the resume keeps recognizing
    // these items.
    if (!changed) continue;
    const patch = metadataPatchTo(
      { ...meta, [ITEM_SOURCE_KEY]: it.id },
      { ...next, [ITEM_SOURCE_KEY]: it.id },
    );
    if (Object.keys(patch).length) out.push({ id: newId, metadata: patch });
  }
  return { patches: out, dropped };
}

async function relinkVocabStructure({
  client,
  vocabData,
  itemIdMap,
  docMaps,
  docIdMap,
  warnings,
  shouldStop,
}) {
  const { patches, dropped } = planVocabRelink(vocabData, itemIdMap, docMaps, docIdMap);
  // One bulk update per chunk, not a batch of one write per entry: a batch
  // re-dispatches the whole REST stack per op inside the held write lock, and an
  // archive's lexicon has as many of these as it has cross-references.
  for (let i = 0; i < patches.length; i += CHUNK) {
    if (shouldStop?.()) throw new ImportCancelled();
    await client.vocabItems.bulkUpdate(patches.slice(i, i + CHUNK));
  }
  if (dropped.length) {
    warnings.push(
      `"${vocabData.name}": ${dropped.length} reference${dropped.length === 1 ? '' : 's'} pointed at something not in the archive and ${dropped.length === 1 ? 'was' : 'were'} dropped (${dropped.slice(0, 5).join('; ')}${dropped.length > 5 ? '; …' : ''})`,
    );
  }
}
