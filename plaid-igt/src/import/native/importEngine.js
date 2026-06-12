// Native archive import engine — rebuilds a project from a Plaid IGT JSON
// archive (docs/native-format.md), implementing the spec's re-import contract.
// Mirrors the FLEx engine's shape (../flex/importEngine.js): layer/vocab
// CREATION is the setup executor's job; this engine runs AFTER setup against
// the resolved project.
//
// Archive ids are correlation keys, never written: every created entity gets
// a fresh id and old→new maps thread references (vocab items ← links, tokens
// ← spans/links). Vocab items are created IN ARRAY ORDER — the archive
// contract that preserves homonym subscripts.
//
// Resumability (same scheme as FLEx): a document is marked done
// (metadata.nativeImported) only after every write succeeded; on resume, done
// documents are skipped and half-imported ones are deleted and redone. Vocab
// items are deduped by metadata.nativeImportId (the archive item id, stamped
// at creation — it doubles as provenance back to the source archive).

import {
  IGT_NAMESPACE, findBaselineTextLayer, findSentenceTokenLayer,
  findWordTokenLayer, findMorphemeTokenLayer, findAlignmentTokenLayer, readScope,
} from '../../domain/igtConfig.js';

const CHUNK = 500; // vocab items + links have no bulk endpoint — chunked batches
const DONE_KEY = 'nativeImported';
const ITEM_SOURCE_KEY = 'nativeImportId';

class ImportCancelled extends Error {
  constructor() { super('Import cancelled'); this.name = 'ImportCancelled'; }
}

/** The setup-wizard input derived from an archive manifest. */
export function deriveSetupData(manifest, projectName) {
  const schema = manifest.schema || {};
  const fields = [
    ...(schema.fields?.sentence || []).map((f) => ({ name: f.name, scope: 'Sentence', isCustom: true })),
    ...(schema.fields?.word || []).map((f) => ({ name: f.name, scope: 'Word', isCustom: true })),
    ...(schema.fields?.morpheme || []).map((f) => ({ name: f.name, scope: 'Morpheme', isCustom: true })),
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
      ignoredTokens: ignored == null ? undefined : (
        ignored.type === 'blacklist'
          ? { mode: 'explicit', explicitIgnoredTokens: ignored.blacklist || [] }
          : { mode: 'unicode-punctuation', unicodePunctuationExceptions: ignored.whitelist || [] }
      ),
    },
    vocabulary: {
      vocabularies: (manifest.vocabularies || []).map((v) => ({
        id: `new-${v.id}`, name: v.name, enabled: true, isCustom: true,
      })),
    },
    documentMetadata: {
      enabledFields: (schema.documentMetadata || []).map((m) => ({
        name: m.name, enabled: true, isCustom: true,
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
  if (!textLayer) throw new Error('No baseline text layer — project setup incomplete');
  const tokenLayers = textLayer.tokenLayers || [];
  const sentenceLayer = findSentenceTokenLayer(tokenLayers);
  const wordLayer = findWordTokenLayer(tokenLayers);
  const morphemeLayer = findMorphemeTokenLayer(tokenLayers);
  const alignmentLayer = findAlignmentTokenLayer(tokenLayers);
  if (!sentenceLayer || !wordLayer || !morphemeLayer) {
    throw new Error('Substrate token layers missing — project setup incomplete');
  }
  const spanLayerByScopeName = new Map();
  for (const tl of tokenLayers) {
    for (const sl of tl.spanLayers || []) {
      spanLayerByScopeName.set(`${readScope(sl.config)}:${sl.name}`, sl.id);
    }
  }
  const schema = manifest.schema || {};
  for (const [scopeKey, scope] of [['sentence', 'Sentence'], ['word', 'Word'], ['morpheme', 'Morpheme']]) {
    for (const f of schema.fields?.[scopeKey] || []) {
      if (!spanLayerByScopeName.has(`${scope}:${f.name}`)) {
        throw new Error(`Annotation field "${f.name}" (${scope}) missing — project setup incomplete`);
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
  };
}

/**
 * Import one vocabulary's items IN ARRAY ORDER (the homonym-subscript
 * contract). Returns Map<archiveItemId, newItemId>. Resume-safe: items
 * already stamped with a matching nativeImportId are reused.
 */
export async function importVocabulary({ client, vocabId, vocabData, onProgress, shouldStop }) {
  const check = () => { if (shouldStop?.()) throw new ImportCancelled(); };

  // Field schema first, so the editor renders the columns from the start.
  if (vocabData.fields?.length) {
    await client.vocabLayers.setConfig(vocabId, IGT_NAMESPACE, 'fields',
      Object.fromEntries(vocabData.fields.map((f) => [f.name, { inline: !!f.inline }])));
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
    client.beginBatch();
    for (const it of chunk) {
      client.vocabItems.create(vocabId, it.form, { ...(it.metadata || {}), [ITEM_SOURCE_KEY]: it.id });
    }
    const results = await client.submitBatch();
    chunk.forEach((it, j) => {
      const id = results[j]?.body?.id ?? results[j]?.id;
      if (id) itemIdMap.set(it.id, id);
    });
    done += chunk.length;
    onProgress?.({ phase: 'vocabulary', name: vocabData.name, done, total: pending.length });
  }
  return itemIdMap;
}

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

const maybeMetadata = (metadata) =>
  (Object.keys(metadata).length ? { metadata } : {});

/** Import one document end to end. Assumes it does not exist yet. */
export async function importNativeDocument({
  client, projectId, targets, docData, itemIdMap, mediaBytes, mediaName,
  onProgress, shouldStop, warnings = [],
}) {
  const progress = (step) => onProgress?.({ phase: 'document', doc: docData.name, step });
  const check = () => { if (shouldStop?.()) throw new ImportCancelled(); };

  progress('Creating document');
  const newDoc = await client.documents.create(projectId, docData.name, docData.metadata || {});
  const docId = newDoc.id ?? newDoc;

  const body = docData.baseline?.body ?? '';
  const tokenIdMap = new Map(); // archive token id → new token id

  if (body.length > 0) {
    progress('Creating text');
    const text = await client.texts.create(
      targets.textLayerId, docId, body, docData.baseline?.metadata || {});
    const textId = text.id ?? text;

    const bulkTokens = async (specs, oldIds) => {
      if (!specs.length) return;
      const { ids } = await client.tokens.bulkCreate(specs);
      oldIds.forEach((oldId, i) => { if (oldId != null && ids[i]) tokenIdMap.set(oldId, ids[i]); });
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
        tokenLayerId: targets.sentenceLayerId, text: textId, begin: s.begin, end: s.end,
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
        tokenLayerId: targets.wordLayerId, text: textId, begin: node.begin, end: node.end,
        ...maybeMetadata(spec),
      })),
      wordNodes.map(({ node }) => node.id),
    );

    check();
    progress('Creating morphemes');
    const morphemeNodes = [
      ...words.flatMap((w) => w.morphemes || []).map((m) => ({ spec: morphemeMetadata(m), node: m })),
      ...orphansBy('morpheme').map((t) => ({ spec: { ...(t.metadata || {}) }, node: t })),
    ];
    await bulkTokens(
      morphemeNodes.map(({ spec, node }) => ({
        tokenLayerId: targets.morphemeLayerId, text: textId, begin: node.begin, end: node.end,
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
        progress('Creating time alignments');
        await bulkTokens(
          alignment.map((a) => ({
            tokenLayerId: targets.alignmentLayerId, text: textId, begin: a.begin, end: a.end,
            metadata: { timeBegin: a.timeBegin, timeEnd: a.timeEnd, ...(a.metadata || {}) },
          })),
          alignment.map((a) => a.id),
        );
      } else {
        warnings.push(`"${docData.name}": ${alignment.length} time alignment(s) skipped — no alignment layer`);
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
      (docData.extraSpans || []).map((s) => s.id).filter((id) => id != null));
    const spansById = new Map();
    const addEntry = (scope, fieldName, entry, oldTokenId) => {
      if (!entry || authoritativeExtraIds.has(entry.id)) return;
      const key = entry.id ?? `${scope}:${fieldName}:${oldTokenId}`;
      let agg = spansById.get(key);
      if (!agg) {
        agg = {
          layerKey: `${scope}:${fieldName}`, tokens: [],
          value: entry.value ?? null, metadata: entry.metadata,
        };
        spansById.set(key, agg);
      }
      agg.tokens.push(oldTokenId);
    };
    for (const s of sentences) {
      for (const [name, entry] of Object.entries(s.fields || {})) addEntry('Sentence', name, entry, s.id);
      for (const w of s.words || []) {
        for (const [name, entry] of Object.entries(w.fields || {})) addEntry('Word', name, entry, w.id);
        for (const m of w.morphemes || []) {
          for (const [name, entry] of Object.entries(m.fields || {})) addEntry('Morpheme', name, entry, m.id);
        }
      }
    }
    const spanSpecs = [];
    const resolveSpan = (layerKey, tokens, value, metadata, label) => {
      const spanLayerId = targets.spanLayerByScopeName.get(layerKey);
      const tokenIds = tokens.map((t) => tokenIdMap.get(t)).filter(Boolean);
      if (!spanLayerId || tokenIds.length !== tokens.length) {
        warnings.push(`"${docData.name}": annotation ${label} skipped (unresolvable ${!spanLayerId ? 'layer' : 'tokens'})`);
        return;
      }
      spanSpecs.push({ spanLayerId, tokens: tokenIds, value, ...(metadata ? { metadata } : {}) });
    };
    for (const agg of spansById.values()) {
      resolveSpan(agg.layerKey, agg.tokens, agg.value, agg.metadata, agg.layerKey);
    }
    for (const extra of docData.extraSpans || []) {
      resolveSpan(
        `${extra.layer?.scope}:${extra.layer?.name}`,
        extra.tokens || [], extra.value ?? null, extra.metadata,
        `${extra.layer?.name} (extra)`,
      );
    }
    // The bulk endpoint requires all spans in one call to share a layer.
    const byLayer = new Map();
    for (const s of spanSpecs) {
      if (!byLayer.has(s.spanLayerId)) byLayer.set(s.spanLayerId, []);
      byLayer.get(s.spanLayerId).push(s);
    }
    for (const specs of byLayer.values()) {
      for (let i = 0; i < specs.length; i += 1000) {
        check();
        await client.spans.bulkCreate(specs.slice(i, i + 1000));
      }
    }

    // Vocab links: inline refs from the tree + the extras section. Link
    // metadata (provenance) rides verbatim.
    progress('Linking lexicon');
    const linkSpecs = [];
    const addLink = (ref, oldTokenIds, label) => {
      if (!ref) return;
      const itemId = itemIdMap.get(ref.itemId);
      const tokenIds = oldTokenIds.map((t) => tokenIdMap.get(t)).filter(Boolean);
      if (!itemId || tokenIds.length !== oldTokenIds.length) {
        warnings.push(`"${docData.name}": vocab link ${label} skipped (unresolvable ${!itemId ? 'item' : 'tokens'})`);
        return;
      }
      linkSpecs.push({ itemId, tokenIds, metadata: ref.metadata });
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
    for (let i = 0; i < linkSpecs.length; i += CHUNK) {
      check();
      client.beginBatch();
      for (const l of linkSpecs.slice(i, i + CHUNK)) {
        client.vocabLinks.create(l.itemId, l.tokenIds, l.metadata);
      }
      await client.submitBatch();
    }
  }

  // Media, from the archive bytes.
  if (mediaBytes) {
    check();
    progress('Uploading media');
    try {
      await client.documents.uploadMedia(docId, new File([mediaBytes], mediaName || 'media'));
    } catch (err) {
      warnings.push(`"${docData.name}": media upload failed: ${err?.message ?? err}`);
    }
  }

  // Mark complete LAST — resume treats unmarked documents as partial.
  await client.documents.setMetadata(docId, { ...(docData.metadata || {}), [DONE_KEY]: true });
  return docId;
}

/**
 * Run a full archive import against a set-up project. Skips documents already
 * marked imported; deletes and redoes half-imported ones. Returns
 * { imported, skipped, redone, warnings }.
 */
export async function runNativeImport({ client, projectId, archive, onProgress, shouldStop }) {
  const project = await client.projects.get(projectId);
  const targets = resolveNativeTargets(project, archive.manifest);
  const warnings = [];

  // Stored app config the setup wizard doesn't cover.
  const autoAnalysis = archive.manifest.schema?.autoAnalysis;
  if (autoAnalysis != null) {
    await client.projects.setConfig(projectId, IGT_NAMESPACE, 'autoAnalysis', autoAnalysis);
  }

  // Vocabularies: archive vocab → the same-named project vocab created by
  // setup. Item maps merge (item ids are unique across vocabularies).
  const projectVocabs = (project.vocabs || []);
  const itemIdMap = new Map();
  for (const vocab of archive.vocabularies) {
    if (shouldStop?.()) throw new ImportCancelled();
    const target = projectVocabs.find((v) => v.name === vocab.name);
    if (!target) {
      warnings.push(`Vocabulary "${vocab.name}" has no same-named target in the project — items skipped`);
      continue;
    }
    const map = await importVocabulary({
      client, vocabId: target.id, vocabData: vocab.data, onProgress, shouldStop,
    });
    for (const [oldId, newId] of map) itemIdMap.set(oldId, newId);
  }

  // Resume bookkeeping: list existing documents once (auto-paginated).
  const existingDocs = await client.projects.listDocuments(projectId);
  const byName = new Map(existingDocs.map((d) => [d.name, d]));

  const results = { imported: 0, skipped: 0, redone: 0 };
  for (let i = 0; i < archive.documents.length; i += 1) {
    if (shouldStop?.()) throw new ImportCancelled();
    const doc = archive.documents[i];
    onProgress?.({ phase: 'document', doc: doc.name, index: i, total: archive.documents.length, step: 'Starting' });
    const existing = byName.get(doc.name);
    if (existing) {
      const full = await client.documents.get(existing.id);
      if (full.metadata?.[DONE_KEY]) {
        results.skipped += 1;
        continue;
      }
      await client.documents.delete(existing.id); // half-imported: redo cleanly
      results.redone += 1;
    }
    await importNativeDocument({
      client, projectId, targets, docData: doc.data, itemIdMap,
      mediaBytes: doc.mediaBytes,
      mediaName: doc.mediaFile ? doc.mediaFile.split('/').at(-1) : null,
      onProgress, shouldStop, warnings,
    });
    results.imported += 1;
  }
  onProgress?.({ phase: 'done', ...results });
  return { ...results, warnings };
}
