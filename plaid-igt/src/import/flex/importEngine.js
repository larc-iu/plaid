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

import { stampInferred, confirmedInferred } from '@larc-iu/plaid-client';
import { documentProgress } from '../progress.js';
import {
  IGT_NAMESPACE,
  findBaselineTextLayer,
  findSentenceTokenLayer,
  findWordTokenLayer,
  findMorphemeTokenLayer,
  readScope,
  readVocabFields,
} from '../../domain/igtConfig.js';
import { pickEn } from './fwdataParser.js';

// Chunk sizes for the bulk endpoints. Each chunk is ONE server transaction
// holding the single SQLite write lock for its whole duration, so the number
// that matters is how long that is, not how few round trips we make: any other
// writer that arrives mid-chunk waits, and is refused with a 503 once the
// server's busy_timeout (5s by default) runs out. Keeping a chunk to a few
// hundred rows keeps a hold well under a second even on a large database.
// Rows per bulk request. Each chunk is ONE server transaction holding the
// single SQLite write lock for its whole duration, so what this bounds is how
// long another writer can be made to wait — not just how many round trips we
// make. A writer that arrives mid-chunk waits, and is refused with a 503 once
// the server's busy_timeout (5s by default) runs out, so keep a hold well
// under a second even on a large database. Nothing here may be unbounded: a
// document's token count is set by the data, not by us.
const BULK_CHUNK = 500;
const DONE_KEY = 'flexImported';

/**
 * Send `items` to a bulk endpoint in BULK_CHUNK-sized slices, concatenating
 * the ids each call returns so the caller still gets one id per input, in
 * input order. `check` runs before each slice so a cancel lands promptly.
 */
async function bulkInChunks(items, check, send) {
  const ids = [];
  for (let i = 0; i < items.length; i += BULK_CHUNK) {
    check?.();
    const res = await send(items.slice(i, i + BULK_CHUNK));
    if (res?.ids) ids.push(...res.ids);
  }
  return ids;
}

/** Display name for an analysis writing system: primary ws gets the bare field name. */
const fieldName = (base, ws, primaryWs) => (ws === primaryWs ? base : `${base} (${ws})`);

/**
 * Derive the wizard pre-fill from a parse: orthographies, annotation fields
 * (one per analysis ws that actually occurs), document metadata fields, and
 * the field→(scope, ws) mapping the engine later imports values through.
 *
 * opts.analysisWss — restrict annotation fields (and lexicon glosses /
 * definitions) to these analysis writing systems (default: every ws that
 * occurs in the data).
 * opts.lexiconFields — names of the other FLEx lexicon fields (Comment,
 * GeneralNote, …; see ir.lexiconFields) to import as vocab item fields
 * (default: none).
 */
// FLEx pins each custom field to one writing system in <CustomField
// wsSelector>: -1 analysis, -2 vernacular, and the plural -3..-6 forms of the
// same two. A value itself arrives as a bare string, so the field's writing
// system is the only record of what language it is in, and the LIFT export
// needs it to tag the <form> correctly. Lexicon classes only.
const VERNACULAR_SELECTORS = new Set(['-2', '-4', '-6']);

function customFieldWritingSystems(ir, baselineWs, primaryAnalysisWs) {
  const out = {};
  for (const f of ir?.customFields ?? []) {
    if (f?.class !== 'LexEntry' && f?.class !== 'LexSense') continue;
    if (!f?.name) continue;
    out[f.name] = VERNACULAR_SELECTORS.has(String(f.wsSelector)) ? baselineWs : primaryAnalysisWs;
  }
  return out;
}

export function deriveImportConfig(ir, build, opts = {}) {
  const primaryAnalysisWs = ir.writingSystems.analysis[0] ?? 'en';
  const wsAllowed = opts.analysisWss ? new Set(opts.analysisWss) : null;
  const fields = [];
  const addField = (kind, scope, base, wss) => {
    for (const ws of wss) {
      if (wsAllowed && !wsAllowed.has(ws)) continue;
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
    { name: 'Source' },
    { name: 'Description' },
    { name: 'Genre' },
  ];

  return {
    // {ws, name}: ws is the FLEx writing-system tag, name the (renamable)
    // plaid orthography name shown in the UI.
    orthographies: build.orthographyWss.map((ws) => ({ ws, name: ws })),
    customFieldWs: customFieldWritingSystems(ir, build.baselineWs, primaryAnalysisWs),
    fields,
    documentMetadata,
    primaryAnalysisWs,
    analysisWss: opts.analysisWss ?? null,
    lexiconFields: opts.lexiconFields ?? [],
    baselineWs: build.baselineWs,
  };
}

/**
 * Resolve engine write targets from a set-up project. Throws when a layer or
 * field the import needs is missing (setup incomplete).
 */
export function resolveTargets(project, config) {
  const textLayer = findBaselineTextLayer(project.textLayers || []);
  if (!textLayer) throw new Error('No baseline text layer. Run project setup first');
  const tokenLayers = textLayer.tokenLayers || [];
  const sentenceLayer = findSentenceTokenLayer(tokenLayers);
  const wordLayer = findWordTokenLayer(tokenLayers);
  const morphemeLayer = findMorphemeTokenLayer(tokenLayers);
  if (!sentenceLayer || !wordLayer || !morphemeLayer) {
    throw new Error('Substrate token layers missing. Run project setup first');
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
    if (!sl)
      throw new Error(`Annotation field "${f.name}" (${f.scope}) missing. Run project setup first`);
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

// Item metadata keys that are bookkeeping or structured data, never a field
// in the vocab's schema (`examples` is shown read-only in the item detail).
const HIDDEN_ITEM_KEYS = new Set(['flexEntry', 'flexSense', 'homograph', 'examples']);

/**
 * Import the lexicon as vocab items, one per FLEx sense (multi-sense entries
 * produce several same-form items; the auto-linker already treats ambiguous
 * forms conservatively). Returns Map<senseGuid, vocabItemId>.
 *
 * Multilingual values (gloss, definition, the opt-in `lexiconFields`) are
 * written per analysis writing system exactly as the text fields are named:
 * the primary ws under the bare key (`gloss`), the others suffixed
 * (`gloss (ru)`); `analysisWss` (null = all) limits which are kept.
 *
 * Resume-safe: items already in the vocab with a matching metadata.flexSense
 * are reused, not duplicated.
 */
export async function importLexicon({
  client,
  vocabId,
  lexicon,
  baselineWs,
  primaryAnalysisWs = 'en',
  analysisWss = null,
  lexiconFields = [],
  customFieldWs = {},
  onProgress,
  shouldStop,
}) {
  const existing = await client.vocabLayers.get(vocabId, true);
  const senseToItem = new Map();
  for (const item of existing.items || []) {
    if (item.metadata?.flexSense) senseToItem.set(item.metadata.flexSense, item.id);
  }

  const wsOk = analysisWss ? new Set(analysisWss) : null;
  const perWs = (base, m) => {
    const out = {};
    for (const [ws, text] of Object.entries(m ?? {})) {
      if (wsOk && !wsOk.has(ws)) continue;
      out[fieldName(base, ws, primaryAnalysisWs)] = text;
    }
    return out;
  };
  const wanted = new Set(lexiconFields);
  const extras = (extra) => {
    const out = {};
    for (const [name, m] of Object.entries(extra ?? {})) {
      if (wanted.has(name)) Object.assign(out, perWs(name, m));
    }
    return out;
  };

  const pending = [];
  // Every metadata key written, in first-seen order, for the field schema.
  // The settled core fields come first even when no item fills them.
  const fieldKeys = new Set(['gloss', 'pos', 'definition', 'morphType', 'lexemeForm']);
  const note = (metadata) => {
    for (const k of Object.keys(metadata)) if (!HIDDEN_ITEM_KEYS.has(k)) fieldKeys.add(k);
  };
  const pickWs = (m) => (m == null ? null : (m[baselineWs] ?? pickEn(m)));
  for (const entry of lexicon) {
    // The item form is the entry's CITATION form (the dictionary headword)
    // when one exists, else the lexeme form; when they differ, the lexeme
    // form is kept as metadata.
    const lexemeForm = pickWs(entry.forms);
    const form = pickWs(entry.citationForm) ?? lexemeForm;
    if (!form) continue;
    // FLEx custom-field values (entry-level + sense-level) become item
    // metadata under the custom field's own name; so do the opt-in extra
    // fields, entry-level ones on every sense of the entry. A sense-level
    // value wins over an entry-level one under the same name.
    const entryMeta = (sense) => ({
      ...(entry.morphType != null && { morphType: entry.morphType }),
      ...(entry.homograph ? { homograph: entry.homograph } : {}),
      ...(lexemeForm != null && lexemeForm !== form && { lexemeForm }),
      ...(entry.custom ?? {}),
      ...(sense?.custom ?? {}),
      ...extras(entry.extra),
      ...extras(sense?.extra),
      flexEntry: entry.guid,
      flexSense: sense?.guid ?? entry.guid,
    });
    for (const sense of entry.senses) {
      const examples = (sense.examples ?? [])
        .map((ex) => ({
          text: pickWs(ex.text),
          ...(pickEn(ex.translations?.[0]) != null && { translation: pickEn(ex.translations[0]) }),
        }))
        .filter((ex) => ex.text);
      const metadata = {
        // gloss first: the editor popover's no-config fallback shows the
        // first metadata value.
        ...perWs('gloss', sense.gloss),
        ...perWs('definition', sense.definition),
        ...(sense.pos != null && { pos: sense.pos }),
        ...(examples.length ? { examples } : {}),
        ...entryMeta(sense),
      };
      note(metadata);
      if (senseToItem.has(sense.guid)) continue;
      pending.push({ form, metadata, senseGuid: sense.guid });
    }
    // Entries with no senses still become one item (form-only).
    if (entry.senses.length === 0) {
      const metadata = entryMeta(null);
      note(metadata);
      if (!senseToItem.has(entry.guid)) pending.push({ form, metadata, senseGuid: entry.guid });
    }
  }

  // Declare the vocab's field schema so gloss/POS render inline in the editor
  // popover and as table columns (idempotent; cheap relative to the import).
  // A vocab that already has a schema (an existing lexicon being extended)
  // keeps its fields, order and inline flags; keys new to it are appended.
  const fieldsConfig = { ...(readVocabFields(existing.config) ?? {}) };
  for (const n of fieldKeys) {
    if (n in fieldsConfig) continue;
    // `lang` records the writing system for the fields that have exactly one
    // (FLEx's custom fields). The multilingual fields carry theirs in the name
    // instead ("gloss (ru)"), so they get none here.
    fieldsConfig[n] = {
      inline: n === 'gloss' || n === 'pos',
      ...(customFieldWs[n] ? { lang: customFieldWs[n] } : {}),
    };
  }
  await client.vocabLayers.setConfig(vocabId, IGT_NAMESPACE, 'fields', fieldsConfig);

  // bulkCreate, not a batch of per-item creates: the bulk endpoint is one
  // request, one operation row and one pass over the table, where a batch of
  // N creates re-dispatches the whole REST stack N times and writes N
  // operation rows — all inside the same held write lock. `ids` come back in
  // input order.
  let done = 0;
  for (let i = 0; i < pending.length; i += BULK_CHUNK) {
    if (shouldStop?.()) throw new Error('Import cancelled');
    const chunk = pending.slice(i, i + BULK_CHUNK);
    const { ids } = await client.vocabItems.bulkCreate(
      chunk.map((p) => ({ vocabLayerId: vocabId, form: p.form, metadata: p.metadata })),
    );
    chunk.forEach((p, j) => {
      if (ids[j]) senseToItem.set(p.senseGuid, ids[j]);
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
// The steps one document goes through, in order, so progress can report how
// far into a document it is and not just which document.
const DOCUMENT_STEPS = [
  'Creating document',
  'Creating text',
  'Creating sentences',
  'Creating words',
  'Creating morphemes',
  'Creating annotations',
  'Linking lexicon',
];

/** Import one document end to end. Assumes it does not exist yet. */
export async function importDocument({
  client,
  projectId,
  targets,
  config,
  doc,
  senseToItem,
  orthographyNames,
  index = 0,
  total = 1,
  onProgress,
  shouldStop,
}) {
  const progress = documentProgress({
    onProgress,
    doc: doc.name,
    index,
    total,
    steps: DOCUMENT_STEPS,
  });
  const check = () => {
    if (shouldStop?.()) throw new Error('Import cancelled');
  };

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
      : [
          {
            begin: 0,
            end: [...doc.body].length,
            freeTranslation: null,
            literalTranslation: null,
            notes: [],
          },
        ];
    // The sentence layer PARTITIONS the text, and the server checks that the
    // tokens tile the whole extent on every bulk call. So this one cannot be
    // chunked: a first chunk ending mid-text is rejected with "Partition must
    // end at the extent's end". A long text therefore holds the write lock for
    // one big transaction, which is the cost of the invariant.
    const { ids: sentenceIds } = await client.tokens.bulkCreate(
      sentenceSpansSpec.map((s) => ({
        tokenLayerId: targets.sentenceLayerId,
        text: textId,
        begin: s.begin,
        end: s.end,
      })),
    );

    // Word tokens, with orthography metadata
    check();
    progress('Creating words');
    const wordIds =
      doc.words.length === 0
        ? []
        : (
            await client.tokens.bulkCreate(
              doc.words.map((w) => {
                const metadata = {};
                for (const [ws, name] of Object.entries(orthographyNames)) {
                  if (w.forms?.[ws] != null) metadata[`orthog:${name}`] = w.forms[ws];
                }
                return {
                  tokenLayerId: targets.wordLayerId,
                  text: textId,
                  begin: w.begin,
                  end: w.end,
                  ...(Object.keys(metadata).length ? { metadata } : {}),
                };
              }),
            )
          ).ids;

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
          wordIndex: wi,
          morpheme: m,
          req: {
            tokenLayerId: targets.morphemeLayerId,
            text: textId,
            begin: w.begin,
            end: w.end,
            precedence: mi + 1,
            ...(Object.keys(metadata).length ? { metadata } : {}),
          },
        });
      });
    });
    const morphIds = await bulkInChunks(
      morphSpecs.map((s) => s.req),
      check,
      (specs) => client.tokens.bulkCreate(specs),
    );

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
      for (const f of fieldsBy('freeTranslation'))
        addSpan(f, sentenceIds[si], s.freeTranslation?.[f.ws]);
      for (const f of fieldsBy('literalTranslation'))
        addSpan(f, sentenceIds[si], s.literalTranslation?.[f.ws]);
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
      await bulkInChunks(specs, check, (part) => client.spans.bulkCreate(part));
    }

    // Vocab links morpheme → lexicon item. FLEx's human-approved analyses
    // import as confirmed; analyses only its morphological parser guessed
    // (never confirmed by the user) keep the unconfirmed-inferred shape, so
    // they render in the needs-review style and confirm-on-touch applies.
    progress('Linking lexicon');
    const linkSpecs = [];
    morphSpecs.forEach((s, i) => {
      const itemId = s.morpheme?.senseGuid && senseToItem.get(s.morpheme.senseGuid);
      if (itemId && morphIds[i]) {
        linkSpecs.push({
          itemId,
          tokenId: morphIds[i],
          approved: doc.words[s.wordIndex]?.approved === true,
        });
      }
    });
    await bulkInChunks(linkSpecs, check, (part) =>
      client.vocabLinks.bulkCreate(
        part.map((l) => ({
          vocabItem: l.itemId,
          tokens: [l.tokenId],
          metadata: l.approved ? confirmedInferred('flex-import') : stampInferred('flex-import'),
        })),
      ),
    );
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
// The whole import is ONE logical operation in the audit log (vocabulary +
// every document); each write keeps its own description underneath. Resumable
// retries start a fresh operation, which is the honest reading of the log.
export async function runImport(args) {
  return args.client.withOperation('Import FLEx project', () => runImportImpl(args));
}

async function runImportImpl({
  client,
  projectId,
  build,
  lexicon,
  config,
  vocabId,
  onProgress,
  shouldStop,
}) {
  const project = await client.projects.get(projectId);
  const targets = resolveTargets(project, config);
  const orthographyNames = Object.fromEntries(
    (config.orthographies ?? []).map((o) => [o.ws ?? o.name, o.name]),
  );

  const senseToItem = await importLexicon({
    client,
    vocabId,
    lexicon,
    baselineWs: config.baselineWs,
    primaryAnalysisWs: config.primaryAnalysisWs,
    customFieldWs: config.customFieldWs ?? {},
    analysisWss: config.analysisWss ?? null,
    lexiconFields: config.lexiconFields ?? [],
    onProgress,
    shouldStop,
  });

  // Resume bookkeeping: list existing documents once (auto-paginated)
  const existingDocs = await client.projects.listDocuments(projectId);
  const byName = new Map(existingDocs.map((d) => [d.name, d]));

  const results = { imported: 0, skipped: 0, redone: 0 };
  for (let i = 0; i < build.documents.length; i += 1) {
    if (shouldStop?.()) throw new Error('Import cancelled');
    const doc = build.documents[i];
    onProgress?.({
      phase: 'document',
      doc: doc.name,
      index: i,
      total: build.documents.length,
      step: 'Starting',
    });
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
      client,
      projectId,
      targets,
      config,
      doc,
      senseToItem,
      orthographyNames,
      index: i,
      total: build.documents.length,
      onProgress,
      shouldStop,
    });
    results.imported += 1;
  }
  onProgress?.({ phase: 'done', ...results });
  return results;
}
