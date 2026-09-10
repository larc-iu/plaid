// ELAN import engine — turns buildElanDocuments() output into plaid API writes.
//
// Same division of labour as the FLEx, CLDF and native engines: layer CREATION
// is the setup executor's job (the flow pre-fills the wizard from
// deriveSetupData and runs the normal setup), and this engine runs AFTER setup
// against the resolved project.
//
// Resumability follows the same scheme (see ../resume.js): a document is
// stamped with its .eaf file name and marked done only once every write for it
// succeeded, so on resume finished documents are skipped and half-imported ones
// are deleted and redone.
//
// The engine is indifferent to WHERE it writes: it resolves every layer and
// field off the project it is handed, so the same run imports into a project
// the ELAN wizard just created or into one that has been worked in for months
// (see ImportElanDocuments). Only the caller differs.
//
// The one thing this engine writes that the others do not is the time-alignment
// layer: a token per aligned segment carrying {timeBegin, timeEnd, speaker} in
// seconds, which is the whole reason an ELAN corpus is worth importing as such
// rather than as plain text.

import { ImportCancelled, importStamp, priorImports, settlePrior, unusedName } from '../resume.js';
import { recordProjectLanguages } from '../projectLanguages.js';
import {
  findBaselineTextLayer,
  findSentenceTokenLayer,
  findWordTokenLayer,
  findMorphemeTokenLayer,
  findAlignmentTokenLayer,
  readScope,
} from '../../domain/igtConfig.js';

// Rows per bulk request. Each chunk is ONE server transaction holding the
// single SQLite write lock for its whole duration, so this bounds how long
// another writer can be made to wait, not just how many round trips we make.
const CHUNK = 500;

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
export function deriveSetupData(build, projectName) {
  return {
    basicInfo: { projectName },
    orthographies: {
      orthographies: [
        { name: 'Baseline', isBaseline: true },
        ...build.schema.orthographies.map((name) => ({ name })),
      ],
    },
    fields: {
      fields: build.schema.fields.map((f) => ({
        name: f.name,
        scope: f.scope,
        lang: f.lang ?? null,
        isCustom: true,
      })),
    },
    vocabulary: { vocabularies: [] },
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
    // Optional: a project without one simply carries no time alignment, which
    // is reported rather than treated as a failed setup.
    alignmentLayerId: findAlignmentTokenLayer(tokenLayers)?.id ?? null,
    spanLayerByScopeName,
  };
}

/**
 * Import one document: text, sentences, alignment, words, morphemes, spans.
 *
 * `copyName` makes it a COPY beside a document the file already produced: it
 * takes that name and carries no resume stamp, so it is the person's own
 * document from then on and a later run of the same import neither skips,
 * replaces nor resumes it.
 */
export async function importDocument({
  client,
  projectId,
  targets,
  doc,
  onProgress,
  shouldStop,
  warnings,
  copyName = null,
}) {
  const progress = (step) => onProgress?.({ phase: 'document', doc: doc.name, step });
  const check = () => {
    if (shouldStop?.()) throw new ImportCancelled();
  };
  const spanLayerFor = (scope, name) => targets.spanLayerByScopeName.get(`${scope}:${name}`);

  progress('Creating document');
  const created = await client.documents.create(
    projectId,
    copyName ?? doc.name,
    copyName ? doc.metadata : importStamp(doc.metadata, doc.id),
  );
  const docId = created.id ?? created;

  if (doc.body.length > 0) {
    progress('Creating text');
    const text = await client.texts.create(targets.textLayerId, docId, doc.body);
    const textId = text.id ?? text;

    check();
    progress('Creating sentences');
    // The sentence layer PARTITIONS the text and the server checks that the
    // tokens tile the whole extent on EVERY bulk call, so this one cannot be
    // chunked: a first chunk ending mid-text is rejected outright.
    const sentenceRes = await client.tokens.bulkCreate(
      doc.sentences.map((s) => ({
        tokenLayerId: targets.sentenceLayerId,
        text: textId,
        begin: s.begin,
        end: s.end,
      })),
    );
    const sentenceIds = sentenceRes.ids ?? sentenceRes;

    // Time alignment. Seconds in metadata, matching the editor's own writes.
    if (doc.alignments.length && targets.alignmentLayerId) {
      check();
      progress('Creating time alignment');
      await bulkInChunks(
        doc.alignments.map((a) => {
          const metadata = { timeBegin: a.timeBegin, timeEnd: a.timeEnd };
          if (a.speaker) metadata.speaker = a.speaker;
          return {
            tokenLayerId: targets.alignmentLayerId,
            text: textId,
            begin: a.begin,
            end: a.end,
            metadata,
          };
        }),
        check,
        (specs) => client.tokens.bulkCreate(specs),
      );
    } else if (doc.alignments.length) {
      warnings?.push(
        `"${doc.name}": the project has no time-alignment layer, so ${doc.alignments.length} aligned segments were skipped.`,
      );
    }

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
          metadata,
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
    for (const w of doc.words) {
      const morphemes = w.morphemes.length ? w.morphemes : [{ form: '', fields: {} }];
      morphemes.forEach((m, mi) => {
        const metadata = { form: m.form ?? '' };
        if (m.morphType) metadata.morphType = m.morphType;
        morphSpecs.push({
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
    }
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

  // The recording the .eaf names, when the user supplied it. Same contract as
  // the CLDF importer: a failure is a warning and the document is left
  // unfinished, so re-importing retries the upload instead of leaving a
  // document that quietly has no media.
  let mediaFailed = false;
  if (doc.mediaFile) {
    check();
    try {
      await client.documents.uploadMedia(docId, doc.mediaFile, `Import media for ${doc.name}`, {
        onProgress: (bytes) =>
          onProgress?.({ phase: 'document', doc: doc.name, step: 'Uploading media', bytes }),
      });
    } catch (err) {
      mediaFailed = true;
      warnings?.push(
        `"${doc.name}": media upload failed. The document is left unfinished so re-importing ` +
          `retries it: ${err?.message ?? err}`,
      );
    }
  }

  // Marked LAST: resume treats an unmarked document as partial and redoes it,
  // which is also how a failed media upload gets another chance. A copy is
  // never resumed, so it is never marked.
  if (!mediaFailed && !copyName) {
    await client.documents.setMetadata(docId, importStamp(doc.metadata, doc.id, true));
  }
  return docId;
}

// The recording chosen for a file whose document is being kept. It is
// uploaded as part of creating a document, so a skipped file used to take its
// recording nowhere, and nothing said so: the file was listed as coming along
// and the tally said "already there". It goes to the existing document when
// that has none, and is left alone when it has one.
async function addRecordingToExisting({ client, existing, doc, results, onProgress, warn }) {
  if (!doc.mediaFile) return;
  if (existing.mediaUrl) {
    results.recordingsUnused += 1;
    return;
  }
  try {
    await client.documents.uploadMedia(existing.id, doc.mediaFile, `Import media for ${doc.name}`, {
      onProgress: (bytes) =>
        onProgress?.({ phase: 'document', doc: doc.name, step: 'Uploading media', bytes }),
    });
    results.recordingsAdded += 1;
  } catch (err) {
    warn(`"${doc.name}": the recording could not be added to it: ${err?.message ?? err}`);
  }
}

/**
 * Run a full import against a set-up project. The whole import is ONE logical
 * operation in the audit log; each write keeps its own description underneath.
 */
export async function runElanImport(args) {
  return args.client.withOperation('Import ELAN corpus', () => runElanImportImpl(args));
}

async function runElanImportImpl({
  client,
  projectId,
  build,
  onProgress,
  onWarning,
  shouldStop,
  prior: priorGiven = null,
  // What to do with a file an earlier run finished: keep its document, replace
  // it, or make a copy beside it.
  priorMode = 'skip',
}) {
  const project = await client.projects.get(projectId);
  const targets = resolveTargets(project, build);
  // What the tier names declare: the transcription tier's writing system and,
  // for glosses and translations, the unmarked Translation field's (the
  // primary analysis language on our side), else the first sentence field
  // that declares one.
  const sentFields = build.schema.fields.filter((f) => f.scope === 'Sentence' && f.lang);
  await recordProjectLanguages(client, project, {
    object: build.schema.baselineLang ?? null,
    meta: (sentFields.find((f) => f.name === 'Translation') ?? sentFields[0])?.lang ?? null,
  });
  // Warnings are reported as they happen, not only in the tally at the end: a
  // long import is exactly when the user wants to see a problem while there is
  // still time to stop.
  const warnings = [];
  const note = (one, document = null) => {
    warnings.push(one);
    onWarning?.(one, { document });
  };
  for (const w of build.warnings) note(w);

  // Resume bookkeeping: what an earlier run made, by .eaf file name. The
  // screen reads this too, to say which files are already in the project, and
  // hands over what it read rather than paying for the listing twice.
  const prior = priorGiven ?? (await priorImports(client, projectId));

  const results = {
    imported: 0,
    skipped: 0,
    redone: 0,
    copied: 0,
    recordingsAdded: 0,
    recordingsUnused: 0,
  };
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
    const warn = (text) => note(text, doc.name);
    const existing = prior.find(doc.id);
    // A copy is only a copy of a document that is finished. One left half
    // done is redone, which is what resume has always meant.
    const copyName =
      priorMode === 'copy' && existing && prior.done(existing)
        ? unusedName(doc.name, prior.names)
        : null;
    if (!copyName) {
      const proceed = await settlePrior(client, prior, doc.id, results, {
        replace: priorMode === 'replace',
      });
      if (!proceed) {
        await addRecordingToExisting({ client, existing, doc, results, onProgress, warn });
        continue;
      }
    }
    await importDocument({
      client,
      projectId,
      targets,
      doc,
      onProgress,
      shouldStop,
      copyName,
      // A push-alike, so a warning raised while writing is logged the moment it
      // happens like any other.
      warnings: { push: (...w) => w.forEach(warn) },
    });
    for (const w of doc.warnings) warn(w);
    if (copyName) results.copied += 1;
    else results.imported += 1;
  }
  onProgress?.({ phase: 'done', ...results });
  return { ...results, warnings };
}
