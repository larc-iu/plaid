// CLDF import engine — turns buildCldfDocuments() output into plaid API writes.
//
// Same division of labour as the FLEx and native engines: layer and vocabulary
// CREATION is the setup executor's job (the flow pre-fills the wizard from
// deriveSetupData and runs the normal setup), and this engine runs AFTER setup
// against the resolved project.
//
// Resumability follows the same scheme: a document is marked done
// (metadata.cldfImported) only once every write for it succeeded, so on resume
// finished documents are skipped and half-imported ones are deleted and redone.
// Lexicon items are deduped by the CLDF entry id stamped at creation, which
// doubles as provenance back to the source dataset.

import { documentProgress } from '../progress.js';
import { ImportCancelled, importStamp, priorImports, settlePrior } from '../resume.js';
import { isReservedFieldName } from '../../domain/vocabFields.js';
import {
  IGT_NAMESPACE,
  readVocabFields,
  findBaselineTextLayer,
  findSentenceTokenLayer,
  findWordTokenLayer,
  findMorphemeTokenLayer,
  readScope,
} from '../../domain/igtConfig.js';

// Rows per bulk request. Each chunk is ONE server transaction holding the
// single SQLite write lock for its whole duration, so this bounds how long
// another writer can be made to wait (and be refused with a 503 once the
// server's busy_timeout runs out), not just how many round trips we make.
const CHUNK = 500;
const ITEM_SOURCE_KEY = 'cldfEntry';

export { ImportCancelled };

async function bulkInChunks(items, check, send) {
  const ids = [];
  for (let i = 0; i < items.length; i += CHUNK) {
    check?.();
    const res = await send(items.slice(i, i + CHUNK));
    if (res?.ids) ids.push(...res.ids);
  }
  return ids;
}

/** The setup-wizard input derived from a build. */
/**
 * The vocabularies a lexicon names, in first-seen order; an entry that names
 * none goes under the default. Empty when there is no lexicon at all.
 */
export const lexiconNames = (lexicon, fallback = 'Lexicon') => {
  if (!lexicon?.length) return [];
  const names = [];
  for (const e of lexicon) {
    const name = e.vocabulary || fallback;
    if (!names.includes(name)) names.push(name);
  }
  return names;
};

export function deriveSetupData(build, projectName, { vocabularyName = 'Lexicon' } = {}) {
  return {
    basicInfo: { projectName },
    orthographies: {
      orthographies: [
        { name: 'Baseline', isBaseline: true },
        ...build.schema.orthographies.map((name) => ({ name })),
      ],
    },
    fields: {
      fields: build.schema.fields.map((f) => ({ name: f.name, scope: f.scope, isCustom: true })),
    },
    vocabulary: {
      // One vocabulary per name the dataset gives its entries (our own export
      // writes a Vocabulary column), else one under the default name.
      vocabularies: lexiconNames(build.lexicon, vocabularyName).map((name, i) => ({
        id: i === 0 ? 'new-cldf-lexicon' : `new-cldf-lexicon-${i + 1}`,
        name,
        enabled: true,
        isCustom: true,
      })),
    },
    documentMetadata: {
      enabledFields: build.schema.documentMetadata.map((m) => ({
        name: m.name,
        enabled: true,
        isCustom: true,
      })),
    },
  };
}

/** Resolve engine write targets. Throws when setup did not produce them. */
export function resolveTargets(project, build) {
  const textLayer = findBaselineTextLayer(project.textLayers || []);
  if (!textLayer) throw new Error('No baseline text layer. Project setup incomplete');
  const tokenLayers = textLayer.tokenLayers || [];
  const sentenceLayer = findSentenceTokenLayer(tokenLayers);
  const wordLayer = findWordTokenLayer(tokenLayers);
  const morphemeLayer = findMorphemeTokenLayer(tokenLayers);
  if (!sentenceLayer || !wordLayer || !morphemeLayer) {
    throw new Error('Substrate token layers missing. Project setup incomplete');
  }
  const spanLayerByScopeName = new Map();
  for (const tl of tokenLayers) {
    for (const sl of tl.spanLayers || []) {
      spanLayerByScopeName.set(`${readScope(sl.config)}:${sl.name}`, sl.id);
    }
  }
  for (const f of build.schema.fields) {
    if (!spanLayerByScopeName.has(`${f.scope}:${f.name}`)) {
      throw new Error(
        `Annotation field "${f.name}" (${f.scope}) missing. Project setup incomplete`,
      );
    }
  }
  return {
    textLayerId: textLayer.id,
    sentenceLayerId: sentenceLayer.id,
    wordLayerId: wordLayer.id,
    morphemeLayerId: morphemeLayer.id,
    spanLayerByScopeName,
  };
}

/**
 * Import the lexicon as vocabulary items. Returns Map<cldfEntryId, itemId>.
 * Resume-safe: items already stamped with a matching entry id are reused.
 *
 * A CLDF entry with more than one sense becomes a headword with its senses
 * under it, as the FLEx import does; with one sense, the sense IS the entry.
 */
export async function importLexicon({ client, vocabId, lexicon, onProgress, shouldStop }) {
  const check = () => {
    if (shouldStop?.()) throw new ImportCancelled();
  };
  const existing = await client.vocabLayers.get(vocabId, true);
  const byEntry = new Map();
  for (const item of existing.items || []) {
    const key = item.metadata?.[ITEM_SOURCE_KEY];
    if (key) byEntry.set(key, item.id);
  }

  // What to create, headword before its senses, and where each sense belongs.
  // The placement is planned for EVERY sense, not only the ones created here:
  // a run that was cancelled part way leaves its items behind unplaced, and a
  // resume that only placed its own creations would leave them flat forever.
  const pending = [];
  const places = [];
  const senseKey = (entry, sense) => `${entry.id}/${sense.id}`;
  for (const entry of lexicon) {
    const split = (entry.senses?.length ?? 0) > 1;
    if (split) {
      for (const [i, sense] of entry.senses.entries()) {
        places.push({ key: senseKey(entry, sense), parentKey: entry.id, senseOrder: i + 1 });
      }
    }
    // The entry and each of its senses are asked about one by one: a run
    // that stopped after making the entry left its senses unmade, and a
    // resume that skipped the whole entry for being there would never make
    // them.
    if (!byEntry.has(entry.id)) {
      const metadata = { ...entry.metadata };
      if (split) {
        // The senses hold these now, one meaning each.
        delete metadata.gloss;
        delete metadata.definition;
      } else {
        // One sense is the entry's own meaning, so what its row carried (its
        // part of speech, its definition, its own fields) belongs on the entry
        // rather than being dropped with the row. The entry's own values win.
        const only = entry.senses?.[0];
        if (only) Object.assign(metadata, { ...(only.metadata || {}), ...metadata });
      }
      pending.push({ key: entry.id, form: entry.form, metadata });
    }
    if (!split) continue;
    for (const sense of entry.senses) {
      if (byEntry.has(senseKey(entry, sense))) continue;
      pending.push({
        key: senseKey(entry, sense),
        form: entry.form,
        metadata: {
          ...(sense.metadata || {}),
          // A sense row with a definition and no gloss carries the definition
          // as its description (the column is required); it is a definition
          // still, not a gloss.
          ...(sense.description ? { gloss: sense.description } : {}),
        },
      });
    }
  }
  // The field schema is the union of what the items actually carry, with the
  // settled core fields always present.
  // A reserved key is structure, never a field: `homograph` rides in on an
  // entry's metadata and would otherwise be declared as one, which the UI
  // forbids creating by hand and the exporter would write out a second time
  // as its own column.
  const fieldKeys = new Set(['gloss', 'pos', 'definition', 'morphType']);
  const addKey = (k) => {
    if (!isReservedFieldName(k)) fieldKeys.add(k);
  };
  for (const entry of lexicon) {
    for (const k of Object.keys(entry.metadata)) addKey(k);
    // A sense carries fields of its own, which the schema has to declare too.
    for (const sense of entry.senses || []) {
      for (const k of Object.keys(sense.metadata || {})) addKey(k);
    }
  }

  let done = 0;
  for (let i = 0; i < pending.length; i += CHUNK) {
    check();
    const slice = pending.slice(i, i + CHUNK);
    const res = await client.vocabItems.bulkCreate(
      slice.map((p) => ({
        vocabLayerId: vocabId,
        form: p.form,
        metadata: { ...p.metadata, [ITEM_SOURCE_KEY]: p.key },
      })),
    );
    (res?.ids || []).forEach((id, n) => byEntry.set(slice[n].key, id));
    done += slice.length;
    onProgress?.({ phase: 'lexicon', done, total: pending.length });
  }

  // The tree, once every item has an id. A sense that already has a parent is
  // left as it is: it was placed by an earlier run, or arranged by hand.
  const parented = new Set(
    (existing.items || []).filter((it) => it.metadata?.parent).map((it) => it.id),
  );
  const placed = places.filter(
    (p) => byEntry.has(p.key) && byEntry.has(p.parentKey) && !parented.has(byEntry.get(p.key)),
  );
  for (let i = 0; i < placed.length; i += CHUNK) {
    check();
    const slice = placed.slice(i, i + CHUNK);
    await client.batched(async () => {
      for (const p of slice) {
        client.vocabItems.patchMetadata(byEntry.get(p.key), {
          parent: byEntry.get(p.parentKey),
          senseOrder: p.senseOrder,
        });
      }
    });
  }

  // The vocab's field schema drives the management table and the item modal.
  // MERGED into what the vocabulary already declares, never written over it:
  // project setup puts the Status field there when it makes the vocabulary,
  // and a vocabulary being added to keeps its own fields, order and inline
  // flags.
  const fieldsConfig = { ...(readVocabFields(existing.config) ?? {}) };
  for (const name of fieldKeys) {
    if (name in fieldsConfig) continue;
    fieldsConfig[name] = { inline: name === 'gloss' || name === 'pos' };
  }
  await client.vocabLayers.setConfig(vocabId, IGT_NAMESPACE, 'fields', fieldsConfig);
  return byEntry;
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
  'Uploading media',
];

/** Import one document: text, sentence partition, words, morphemes, spans. */
export async function importDocument({
  client,
  projectId,
  targets,
  doc,
  index = 0,
  total = 1,
  onProgress,
  shouldStop,
  warnings,
}) {
  const progress = documentProgress({
    onProgress,
    doc: doc.name,
    index,
    total,
    steps: DOCUMENT_STEPS,
  });
  const check = () => {
    if (shouldStop?.()) throw new ImportCancelled();
  };
  const spanLayerFor = (scope, name) => targets.spanLayerByScopeName.get(`${scope}:${name}`);

  progress('Creating document');
  const created = await client.documents.create(
    projectId,
    doc.name,
    importStamp(doc.metadata, doc.id),
  );
  const docId = created.id ?? created;

  if (doc.body.length > 0) {
    progress('Creating text');
    const text = await client.texts.create(targets.textLayerId, docId, doc.body);
    const textId = text.id ?? text;

    check();
    progress('Creating sentences');
    // The sentence layer PARTITIONS the text, and the server checks that the
    // tokens tile the whole extent on every bulk call. So this one cannot be
    // chunked: a first chunk ending mid-text is rejected with "Partition must
    // end at the extent's end". A long text therefore holds the write lock for
    // one big transaction, which is the cost of the invariant.
    const { ids: sentenceIds } = await client.tokens.bulkCreate(
      doc.sentences.map((s) => ({
        tokenLayerId: targets.sentenceLayerId,
        text: textId,
        begin: s.begin,
        end: s.end,
      })),
    );

    check();
    progress('Creating words');
    const wordIds = await bulkInChunks(
      doc.words.map((w) => {
        // Orthography values ride in token metadata under the orthog: prefix,
        // the same convention the editor and the other importers use.
        const metadata = {};
        for (const [key, value] of Object.entries(w.fields)) {
          if (key.startsWith('orthog:')) metadata[key] = value;
        }
        return {
          tokenLayerId: targets.wordLayerId,
          text: textId,
          begin: w.begin,
          end: w.end,
          ...(Object.keys(metadata).length ? { metadata } : {}),
        };
      }),
      check,
      (specs) => client.tokens.bulkCreate(specs),
    );

    // Morphemes span the whole word with a 1-based precedence. Every word gets
    // at least one, which is the invariant reconcileOnOpen would otherwise heal
    // one at a time on first open.
    check();
    progress('Creating morphemes');
    const morphSpecs = [];
    doc.words.forEach((w, wi) => {
      const morphemes = w.morphemes.length ? w.morphemes : [{ form: '', fields: {} }];
      morphemes.forEach((m, mi) => {
        const metadata = { form: m.form ?? '' };
        if (m.morphType) metadata.morphType = m.morphType;
        morphSpecs.push({
          wordIndex: wi,
          morpheme: m,
          req: {
            tokenLayerId: targets.morphemeLayerId,
            text: textId,
            begin: w.begin,
            end: w.end,
            precedence: mi + 1,
            metadata,
          },
        });
      });
    });
    const morphIds = await bulkInChunks(
      morphSpecs.map((s) => s.req),
      check,
      (specs) => client.tokens.bulkCreate(specs),
    );

    check();
    progress('Creating annotations');
    const spanSpecs = [];
    const addSpan = (scope, name, tokenId, value) => {
      if (!value || !tokenId) return;
      const spanLayerId = spanLayerFor(scope, name);
      if (!spanLayerId) return;
      spanSpecs.push({ spanLayerId, tokens: [tokenId], value });
    };
    doc.sentences.forEach((s, si) => {
      for (const [name, value] of Object.entries(s.fields)) {
        addSpan('Sentence', name, sentenceIds[si], value);
      }
    });
    doc.words.forEach((w, wi) => {
      for (const [name, value] of Object.entries(w.fields)) {
        if (name.startsWith('orthog:')) continue; // already token metadata
        addSpan('Word', name, wordIds[wi], value);
      }
    });
    morphSpecs.forEach((s, i) => {
      for (const [name, value] of Object.entries(s.morpheme.fields || {})) {
        addSpan('Morpheme', name, morphIds[i], value);
      }
    });
    // The bulk endpoint requires every span in one call to share a layer.
    const byLayer = new Map();
    for (const s of spanSpecs) {
      if (!byLayer.has(s.spanLayerId)) byLayer.set(s.spanLayerId, []);
      byLayer.get(s.spanLayerId).push(s);
    }
    for (const specs of byLayer.values()) {
      await bulkInChunks(specs, check, (part) => client.spans.bulkCreate(part));
    }
  }

  let mediaFailed = false;
  if (doc.mediaBytes) {
    check();
    progress('Uploading media');
    try {
      await client.documents.uploadMedia(
        docId,
        new File([doc.mediaBytes], doc.mediaName || 'media'),
      );
    } catch (err) {
      mediaFailed = true;
      warnings?.push(
        `"${doc.name}": media upload failed. The document is left unfinished so re-importing ` +
          `retries it: ${err?.message ?? err}`,
      );
    }
  }

  // Marked LAST: resume treats an unmarked document as partial and redoes it,
  // which is also how a failed media upload gets another chance.
  if (!mediaFailed) {
    await client.documents.setMetadata(docId, importStamp(doc.metadata, doc.id, true));
  }
  return docId;
}

/**
 * Run a full import against a set-up project. The whole import is ONE logical
 * operation in the audit log; each write keeps its own description underneath.
 */
export async function runCldfImport(args) {
  return args.client.withOperation('Import CLDF dataset', () => runCldfImportImpl(args));
}

async function runCldfImportImpl({ client, projectId, build, onProgress, shouldStop }) {
  const project = await client.projects.get(projectId);
  const targets = resolveTargets(project, build);
  const warnings = [...build.warnings];

  // The dataset's LanguageTable is where the project's language identity comes
  // from. Only set when the dataset actually named one.
  if (build.languages.object || build.languages.meta) {
    const empty = { name: '', glottocode: '', iso639P3: '', latitude: null, longitude: null };
    await client.projects.setConfig(projectId, IGT_NAMESPACE, 'languages', {
      object: { ...empty, ...(build.languages.object || {}) },
      meta: { ...empty, ...(build.languages.meta || {}) },
    });
  }

  if (build.lexicon.length) {
    // Each vocabulary the dataset names, into the project vocabulary of that
    // name; with one lexicon and one vocabulary, whatever that vocabulary is
    // called (a resume may have renamed it).
    const vocabs = project.vocabs || [];
    const names = lexiconNames(build.lexicon);
    for (const name of names) {
      const vocab =
        names.length === 1 && vocabs.length === 1 ? vocabs[0] : vocabs.find((v) => v.name === name);
      if (!vocab) {
        warnings.push(
          `No project vocabulary named "${name}" was created, so its entries were skipped.`,
        );
        continue;
      }
      await importLexicon({
        client,
        vocabId: vocab.id,
        lexicon: build.lexicon.filter((e) => (e.vocabulary || 'Lexicon') === name),
        onProgress,
        shouldStop,
      });
    }
  }

  // Resume bookkeeping: what an earlier run made, by CLDF document id.
  const prior = await priorImports(client, projectId);

  const results = { imported: 0, skipped: 0, redone: 0 };
  for (let i = 0; i < build.documents.length; i += 1) {
    if (shouldStop?.()) throw new ImportCancelled();
    const doc = build.documents[i];
    onProgress?.({
      phase: 'document',
      doc: doc.name,
      index: i,
      total: build.documents.length,
      step: 'Starting',
    });
    if (!(await settlePrior(client, prior, doc.id, results))) continue;
    await importDocument({
      client,
      projectId,
      targets,
      doc,
      index: i,
      total: build.documents.length,
      onProgress,
      shouldStop,
      warnings,
    });
    warnings.push(...doc.warnings);
    results.imported += 1;
  }
  onProgress?.({ phase: 'done', ...results });
  return { ...results, warnings };
}
