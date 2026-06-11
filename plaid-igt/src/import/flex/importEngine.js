// FLEx import engine — turns buildDocuments() output into plaid API writes.
//
// Layer/vocab CREATION is the setup wizard's job (the import flow pre-fills
// the wizard from deriveImportConfig and runs the normal setup). This engine
// runs AFTER setup against the resolved project: it imports the lexicon into
// the project vocabulary, then each document (text, sentence partition, word
// tokens with orthographies, morpheme tokens, annotation spans, vocab links).
//
// Resumability: a document is only marked done (metadata.flexImported) after
// every write for it succeeded. On resume, done documents are skipped and
// half-imported ones are deleted and redone. Lexicon items are deduped by
// their FLEx sense guid (metadata.flexSense).

import { findBaselineTextLayer, findSentenceTokenLayer, findWordTokenLayer, findMorphemeTokenLayer, readScope } from '../../domain/igtConfig.js';
import { pickEn } from './fwdataParser.js';

const LINK_CHUNK = 500; // vocab links have no bulk endpoint — chunked batches
const DONE_KEY = 'flexImported';

/** Display name for an analysis writing system: primary ws gets the bare field name. */
const fieldName = (base, ws, primaryWs) => (ws === primaryWs ? base : `${base} (${ws})`);

/**
 * Derive the wizard pre-fill from a parse: orthographies, annotation fields
 * (one per analysis ws that actually occurs), document metadata fields, and
 * the field→(scope, ws) mapping the engine later imports values through.
 */
export function deriveImportConfig(ir, build) {
  const primaryAnalysisWs = ir.writingSystems.analysis[0] ?? 'en';
  const fields = [];
  const addField = (kind, scope, base, wss) => {
    for (const ws of wss) {
      fields.push({ kind, scope, ws, name: fieldName(base, ws, primaryAnalysisWs) });
    }
  };
  addField('wordGloss', 'Word', 'Gloss', ir.wsUsage.wordGloss);
  if (build.documents.some((d) => d.words.some((w) => w.pos))) {
    fields.push({ kind: 'wordPos', scope: 'Word', ws: null, name: 'POS' });
  }
  addField('morphGloss', 'Morpheme', 'Gloss', ir.wsUsage.morphGloss);
  if (build.documents.some((d) => d.words.some((w) => w.morphemes?.some((m) => m.pos)))) {
    fields.push({ kind: 'morphPos', scope: 'Morpheme', ws: null, name: 'POS' });
  }
  addField('freeTranslation', 'Sentence', 'Translation', ir.wsUsage.freeTranslation);
  addField('literalTranslation', 'Sentence', 'Literal Translation', ir.wsUsage.literalTranslation);
  addField('note', 'Sentence', 'Note', ir.wsUsage.note);

  // Alternate text titles (e.g. the English names of vernacular-titled texts)
  const titleWss = new Set();
  for (const d of build.documents) {
    for (const ws of Object.keys(d.names)) {
      if (d.names[ws] !== d.name) titleWss.add(ws);
    }
  }
  const documentMetadata = [
    ...[...titleWss].map((ws) => ({ name: `Title (${ws})` })),
    { name: 'Source' }, { name: 'Description' }, { name: 'Genre' },
  ];

  return {
    // {ws, name}: ws is the FLEx writing-system tag, name the (renamable)
    // plaid orthography name shown in the UI.
    orthographies: build.orthographyWss.map((ws) => ({ ws, name: ws })),
    fields,
    documentMetadata,
    primaryAnalysisWs,
    baselineWs: build.baselineWs,
  };
}

/**
 * Resolve engine write targets from a set-up project. Throws when a layer or
 * field the import needs is missing (setup incomplete).
 */
export function resolveTargets(project, config) {
  const textLayer = findBaselineTextLayer(project.textLayers || []);
  if (!textLayer) throw new Error('No baseline text layer — run project setup first');
  const tokenLayers = textLayer.tokenLayers || [];
  const sentenceLayer = findSentenceTokenLayer(tokenLayers);
  const wordLayer = findWordTokenLayer(tokenLayers);
  const morphemeLayer = findMorphemeTokenLayer(tokenLayers);
  if (!sentenceLayer || !wordLayer || !morphemeLayer) {
    throw new Error('Substrate token layers missing — run project setup first');
  }
  const spanLayerByScopeName = new Map();
  for (const tl of tokenLayers) {
    for (const sl of tl.spanLayers || []) {
      spanLayerByScopeName.set(`${readScope(sl.config)}:${sl.name}`, sl);
    }
  }
  const fieldLayers = new Map(); // field name+scope → span layer id
  for (const f of config.fields) {
    const sl = spanLayerByScopeName.get(`${f.scope}:${f.name}`);
    if (!sl) throw new Error(`Annotation field "${f.name}" (${f.scope}) missing — run project setup first`);
    fieldLayers.set(f, sl.id);
  }
  return {
    textLayerId: textLayer.id,
    sentenceLayerId: sentenceLayer.id,
    wordLayerId: wordLayer.id,
    morphemeLayerId: morphemeLayer.id,
    fieldLayers,
  };
}

/**
 * Import the lexicon as vocab items, one per FLEx sense (multi-sense entries
 * produce several same-form items; the auto-linker already treats ambiguous
 * forms conservatively). Returns Map<senseGuid, vocabItemId>.
 *
 * Resume-safe: items already in the vocab with a matching metadata.flexSense
 * are reused, not duplicated.
 */
export async function importLexicon({ client, vocabId, lexicon, baselineWs, onProgress, shouldStop }) {
  const existing = await client.vocabLayers.get(vocabId, true);
  const senseToItem = new Map();
  for (const item of existing.items || []) {
    if (item.metadata?.flexSense) senseToItem.set(item.metadata.flexSense, item.id);
  }

  const pending = [];
  for (const entry of lexicon) {
    const form = entry.forms?.[baselineWs] ?? pickEn(entry.forms) ?? pickEn(entry.citationForm);
    if (!form) continue;
    for (const sense of entry.senses) {
      if (senseToItem.has(sense.guid)) continue;
      const metadata = {
        flexEntry: entry.guid,
        flexSense: sense.guid,
        ...(pickEn(sense.gloss) != null && { gloss: pickEn(sense.gloss) }),
        ...(sense.pos != null && { pos: sense.pos }),
        ...(entry.morphType != null && { morphType: entry.morphType }),
        ...(entry.homograph ? { homograph: entry.homograph } : {}),
      };
      pending.push({ form, metadata, senseGuid: sense.guid });
    }
    // Entries with no senses still become one item (form-only).
    if (entry.senses.length === 0 && !senseToItem.has(entry.guid)) {
      pending.push({ form, metadata: { flexEntry: entry.guid, flexSense: entry.guid, ...(entry.morphType != null && { morphType: entry.morphType }) }, senseGuid: entry.guid });
    }
  }

  let done = 0;
  for (let i = 0; i < pending.length; i += LINK_CHUNK) {
    if (shouldStop?.()) throw new Error('Import cancelled');
    const chunk = pending.slice(i, i + LINK_CHUNK);
    client.beginBatch();
    for (const p of chunk) client.vocabItems.create(vocabId, p.form, p.metadata);
    const results = await client.submitBatch();
    chunk.forEach((p, j) => {
      const id = results[j]?.body?.id ?? results[j]?.id;
      if (id) senseToItem.set(p.senseGuid, id);
    });
    done += chunk.length;
    onProgress?.({ phase: 'lexicon', done, total: pending.length });
  }
  return senseToItem;
}

/** Flatten a document's FLEx metadata onto the configured metadata fields. */
function documentMetadataOf(doc) {
  const md = {};
  for (const [ws, title] of Object.entries(doc.names)) {
    if (title !== doc.name) md[`Title (${ws})`] = title;
  }
  if (doc.source) md.Source = pickEn(doc.source);
  if (doc.description) md.Description = pickEn(doc.description);
  if (doc.genres?.length) md.Genre = doc.genres.join(', ');
  return md;
}

/** Import one document end to end. Assumes it does not exist yet. */
export async function importDocument({ client, projectId, targets, config, doc, senseToItem, orthographyNames, onProgress, shouldStop }) {
  const progress = (step) => onProgress?.({ phase: 'document', doc: doc.name, step });
  const check = () => { if (shouldStop?.()) throw new Error('Import cancelled'); };

  progress('Creating document');
  const newDoc = await client.documents.create(projectId, doc.name, documentMetadataOf(doc));
  const docId = newDoc.id ?? newDoc;

  if (doc.body.length > 0) {
    progress('Creating text');
    const text = await client.texts.create(targets.textLayerId, docId, doc.body);
    const textId = text.id ?? text;

    // Sentence partition (single bulk call; partitioning layers require bulk)
    check();
    progress('Creating sentences');
    const sentenceSpansSpec = doc.sentences.length
      ? doc.sentences
      : [{ begin: 0, end: [...doc.body].length, freeTranslation: null, literalTranslation: null, notes: [] }];
    const sentenceIds = (await client.tokens.bulkCreate(
      sentenceSpansSpec.map((s) => ({ tokenLayerId: targets.sentenceLayerId, text: textId, begin: s.begin, end: s.end })),
    )).ids;

    // Word tokens, with orthography metadata
    check();
    progress('Creating words');
    const wordIds = doc.words.length === 0 ? [] : (await client.tokens.bulkCreate(
      doc.words.map((w) => {
        const metadata = {};
        for (const [ws, name] of Object.entries(orthographyNames)) {
          if (w.forms?.[ws] != null) metadata[`orthog:${name}`] = w.forms[ws];
        }
        return {
          tokenLayerId: targets.wordLayerId, text: textId, begin: w.begin, end: w.end,
          ...(Object.keys(metadata).length ? { metadata } : {}),
        };
      }),
    )).ids;

    // Morpheme tokens: full word extent, 1-based precedence, metadata.form +
    // morphType. Words FLEx never analyzed get one bare default morpheme
    // (the IGT invariant reconcileOnOpen would otherwise heal one by one).
    check();
    progress('Creating morphemes');
    const morphSpecs = [];
    doc.words.forEach((w, wi) => {
      const ms = w.morphemes?.length ? w.morphemes : [null];
      ms.forEach((m, mi) => {
        const metadata = {};
        const form = m && (m.forms?.[config.baselineWs] ?? pickEn(m.forms));
        if (form != null) metadata.form = form;
        if (m?.morphType != null) metadata.morphType = m.morphType;
        morphSpecs.push({
          wordIndex: wi, morpheme: m,
          req: {
            tokenLayerId: targets.morphemeLayerId, text: textId,
            begin: w.begin, end: w.end, precedence: mi + 1,
            ...(Object.keys(metadata).length ? { metadata } : {}),
          },
        });
      });
    });
    const morphIds = morphSpecs.length === 0 ? [] : (await client.tokens.bulkCreate(morphSpecs.map((s) => s.req))).ids;

    // Annotation spans, all scopes in chunked bulk calls
    check();
    progress('Creating annotations');
    const spanSpecs = [];
    const addSpan = (field, tokenId, value) => {
      if (value == null || tokenId == null) return;
      const layerId = targets.fieldLayers.get(field);
      spanSpecs.push({ spanLayerId: layerId, tokens: [tokenId], value });
    };
    const fieldsBy = (kind) => config.fields.filter((f) => f.kind === kind);
    doc.sentences.forEach((s, si) => {
      for (const f of fieldsBy('freeTranslation')) addSpan(f, sentenceIds[si], s.freeTranslation?.[f.ws]);
      for (const f of fieldsBy('literalTranslation')) addSpan(f, sentenceIds[si], s.literalTranslation?.[f.ws]);
      for (const f of fieldsBy('note')) {
        const notes = s.notes.map((n) => n[f.ws]).filter(Boolean);
        if (notes.length) addSpan(f, sentenceIds[si], notes.join('\n'));
      }
    });
    doc.words.forEach((w, wi) => {
      for (const f of fieldsBy('wordGloss')) addSpan(f, wordIds[wi], w.gloss?.[f.ws]);
      for (const f of fieldsBy('wordPos')) addSpan(f, wordIds[wi], w.pos);
    });
    morphSpecs.forEach((s, i) => {
      if (!s.morpheme) return;
      for (const f of fieldsBy('morphGloss')) addSpan(f, morphIds[i], s.morpheme.gloss?.[f.ws]);
      for (const f of fieldsBy('morphPos')) addSpan(f, morphIds[i], s.morpheme.pos);
    });
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

    // Vocab links morpheme → lexicon item, stamped as confirmed provenance
    // (these were human decisions in FLEx).
    progress('Linking lexicon');
    const linkSpecs = [];
    morphSpecs.forEach((s, i) => {
      const itemId = s.morpheme?.senseGuid && senseToItem.get(s.morpheme.senseGuid);
      if (itemId && morphIds[i]) linkSpecs.push({ itemId, tokenId: morphIds[i] });
    });
    const linkMeta = { prov: 'inferred', provSource: 'flex-import', provConfirmed: true };
    for (let i = 0; i < linkSpecs.length; i += LINK_CHUNK) {
      check();
      client.beginBatch();
      for (const l of linkSpecs.slice(i, i + LINK_CHUNK)) {
        client.vocabLinks.create(l.itemId, [l.tokenId], linkMeta);
      }
      await client.submitBatch();
    }
  }

  // Mark complete LAST — resume treats unmarked documents as partial.
  await client.documents.setMetadata(docId, { ...documentMetadataOf(doc), [DONE_KEY]: true });
  return docId;
}

/**
 * Run a full import against a set-up project. Skips documents already marked
 * imported; deletes and redoes half-imported ones. onProgress receives
 * {phase: 'lexicon'|'document'|'done', ...} updates throughout.
 */
export async function runImport({ client, projectId, build, lexicon, config, vocabId, onProgress, shouldStop }) {
  const project = await client.projects.get(projectId);
  const targets = resolveTargets(project, config);
  const orthographyNames = Object.fromEntries(
    (config.orthographies ?? []).map((o) => [o.ws ?? o.name, o.name]));

  const senseToItem = await importLexicon({
    client, vocabId, lexicon, baselineWs: config.baselineWs, onProgress, shouldStop,
  });

  // Resume bookkeeping: list existing documents once (auto-paginated)
  const existingDocs = await client.projects.listDocuments(projectId);
  const byName = new Map(existingDocs.map((d) => [d.name, d]));

  const results = { imported: 0, skipped: 0, redone: 0 };
  for (let i = 0; i < build.documents.length; i += 1) {
    if (shouldStop?.()) throw new Error('Import cancelled');
    const doc = build.documents[i];
    onProgress?.({ phase: 'document', doc: doc.name, index: i, total: build.documents.length, step: 'Starting' });
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
    await importDocument({
      client, projectId, targets, config, doc, senseToItem, orthographyNames, onProgress, shouldStop,
    });
    results.imported += 1;
  }
  onProgress?.({ phase: 'done', ...results });
  return results;
}
