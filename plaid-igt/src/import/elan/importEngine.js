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
// are deleted and redone. Into a project open for work (`projectOpen`) nothing
// is deleted unasked: a document an earlier run left unfinished is kept like a
// finished one unless the person says Replace, and a run that stops removes
// only the document it was making.
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

import {
  withoutStamps,
  ImportCancelled,
  importStamp,
  priorImports,
  settlePrior,
} from '../resume.js';
import { recordProjectLanguages } from '../projectLanguages.js';
import {
  createDocumentShell,
  finishDocument,
  resolveIgtTargets,
  setupDataFor,
  writeAlignments,
  writeDocumentLayers,
} from '../project.js';
import { mediaUploadFailure } from '../mediaUpload.js';
import {
  SENTENCE_ROLES,
  findBaselineTextLayer,
  readScope,
  readSentenceRole,
} from '../../domain/igtConfig.js';

export { ImportCancelled };

/** The setup-wizard input derived from a build. */
export function deriveSetupData(build, projectName) {
  return setupDataFor({
    projectName,
    orthographies: build.schema.orthographies,
    fields: build.schema.fields,
    // An .eaf says nothing about which words to skip, so the project gets the
    // rule every new project starts with.
    documentMetadata: build.schema.documentMetadata.map((m) => m.name),
  });
}

/** Resolve engine write targets. Throws when setup did not produce them. */
export function resolveTargets(project, build) {
  return resolveIgtTargets(project, build.schema.fields);
}

/**
 * Import one document: text, sentences, alignment, words, morphemes, spans.
 *
 * `copyName` makes it a COPY beside a document the file already produced: it
 * takes that name, or the first free "name (2)" core gives it, and carries no
 * resume stamp, so it is the person's own
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
  onDocument = null,
}) {
  const progress = (step) => onProgress?.({ phase: 'document', doc: doc.name, step });
  const check = () => {
    if (shouldStop?.()) throw new ImportCancelled();
  };
  const spanLayerFor = (scope, name) => targets.spanLayerByScopeName.get(`${scope}:${name}`);

  const {
    documentId: docId,
    textId,
    sentenceIds,
  } = await createDocumentShell({
    client,
    projectId,
    targets,
    name: copyName ?? doc.name,
    // A copy's metadata is the file's own less any key named like one of the
    // import's marks (an .eaf header property may be), which would let a later
    // run take the copy for a document it made.
    metadata: copyName
      ? withoutStamps(doc.metadata)
      : (id) => importStamp(doc.metadata, doc.id, id),
    body: doc.body,
    tokenEdges: doc.tokenEdges,
    onDocument,
    sentences: doc.sentences,
    progress,
    check,
  });

  if (textId) {
    const aligned = await writeAlignments({
      client,
      targets,
      textId,
      alignments: doc.alignments,
      check,
      progress,
    });
    if (!aligned) {
      warnings?.push(
        `"${doc.name}": ${doc.alignments.length} aligned segments were skipped. This project is not set up for time alignment.`,
      );
    }

    // Orthography values ride in token metadata under the orthog: prefix,
    // the same convention the editor and the other importers use. Every other
    // field is a span on its layer.
    const spansOf = (scope, fields) =>
      Object.entries(fields || {})
        .filter(([name, value]) => value && !name.startsWith('orthog:'))
        .map(([name, value]) => ({ layerId: spanLayerFor(scope, name), value }));
    await writeDocumentLayers({
      client,
      targets,
      textId,
      sentenceIds,
      sentenceSpans: doc.sentences.map((s) => spansOf('Sentence', s.fields)),
      words: doc.words.map((w) => ({
        begin: w.begin,
        end: w.end,
        metadata: Object.fromEntries(
          Object.entries(w.fields).filter(([key]) => key.startsWith('orthog:')),
        ),
        spans: spansOf('Word', w.fields),
        morphemes: (w.morphemes || []).map((m) => ({
          metadata: {
            ...(m.form != null ? { form: m.form } : {}),
            ...(m.morphType ? { morphType: m.morphType } : {}),
          },
          spans: spansOf('Morpheme', m.fields),
        })),
      })),
      check,
      progress,
    });
  }

  // The recording the .eaf names, when the user supplied it. Into an open
  // project a document whose upload failed is kept, and importing the file
  // again with its recording adds the recording to it
  // (addRecordingToExisting). A copy is never resumed, so it is never marked.
  await finishDocument({
    client,
    documentId: docId,
    name: doc.name,
    media: doc.mediaFile,
    stamp: copyName ? null : { metadata: doc.metadata, sourceId: doc.id },
    onProgress,
    progress,
    check,
    warnings,
  });
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
    warn(
      `"${doc.name}": the recording could not be added to it: ${await mediaUploadFailure(client, err)}`,
    );
  }
}

// The document a stopped or failed run was making, in a project open for
// work. A later run would list it as imported before and keep it, half made.
// When the delete fails too, it stays, and the error names it
// (`unfinishedLeft`), so the screen can say so and its retry redo it.
async function removeUnfinished(client, documentId, name, err) {
  try {
    await client.documents.delete(documentId);
    err.unfinishedRemoved = true;
  } catch (cleanup) {
    console.error('Could not remove the unfinished document:', cleanup);
    err.unfinishedRemoved = false;
    err.unfinishedLeft = { id: documentId, name };
  }
}

/**
 * Run a full import against a set-up project. The whole import is ONE logical
 * operation in the audit log; each write keeps its own description underneath.
 */
export async function runElanImport(args) {
  return args.client.withOperation('Import ELAN corpus', () => runElanImportImpl(args), {
    kind: 'import',
    ref: 'format:elan',
  });
}

async function runElanImportImpl({
  client,
  projectId,
  build,
  onProgress,
  onWarning,
  shouldStop,
  prior: priorGiven = null,
  // What to do with a file an earlier run imported: keep its document, replace
  // it, or make a copy beside it.
  priorMode = 'skip',
  // The project is open for work (no import record locks it), so a document
  // an earlier run left unfinished may hold someone's work: priorMode decides
  // for it as for a finished one, and a run that stops or fails deletes the
  // document it was making, which no one has had the chance to work on.
  projectOpen = false,
  // Documents a failed run of this screen made and could not remove: no one
  // has worked on them, so they are redone whatever priorMode says.
  redo = [],
}) {
  const project = await client.projects.get(projectId);
  const targets = resolveTargets(project, build);
  // What the tier names declare: the transcription tier's writing system and,
  // for glosses and translations, the language of the sentence field whose
  // stored role is the translation when the tiers name its language, else of
  // the first sentence field they name one for.
  const sentFields = build.schema.fields.filter((f) => f.scope === 'Sentence' && f.lang);
  const roleOf = new Map();
  for (const tl of findBaselineTextLayer(project?.textLayers || [])?.tokenLayers || []) {
    for (const sl of tl.spanLayers || []) {
      if (readScope(sl.config) === 'Sentence') roleOf.set(sl.name, readSentenceRole(sl.config));
    }
  }
  const metaField =
    sentFields.find((f) => roleOf.get(f.name) === SENTENCE_ROLES.TRANSLATION) ?? sentFields[0];
  await recordProjectLanguages(client, project, {
    object: build.schema.baselineLang ?? null,
    meta: metaField?.lang ?? null,
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
    // Every report from inside a document says which one it is. Only the
    // first used to, so the screens read the rest as the first document.
    const docProgress = (p) => onProgress?.({ ...p, index: i, total: build.documents.length });
    docProgress({ phase: 'document', doc: doc.name, step: 'Starting' });
    const warn = (text) => note(text, doc.name);
    const existing = prior.find(doc.id);
    const leftover = !!existing && redo.includes(existing.id);
    // A copy is only a copy of a document that is finished, or one an open
    // project keeps. One a resume left half done is redone, which is what
    // resume has always meant.
    // Core names the copy "Name (2)" (createDocumentShell's freeName).
    const copyName =
      priorMode === 'copy' && existing && !leftover && (prior.done(existing) || projectOpen)
        ? doc.name
        : null;
    if (!copyName) {
      const proceed = await settlePrior(client, prior, doc.id, results, {
        replace: priorMode === 'replace' || leftover,
        keepUnfinished: projectOpen,
      });
      if (!proceed) {
        await addRecordingToExisting({
          client,
          existing,
          doc,
          results,
          onProgress: docProgress,
          warn,
        });
        continue;
      }
    }
    let making = null;
    try {
      await importDocument({
        client,
        projectId,
        targets,
        doc,
        onProgress: docProgress,
        shouldStop,
        copyName,
        onDocument: (id) => {
          making = id;
        },
        // A push-alike, so a warning raised while writing is logged the moment it
        // happens like any other.
        warnings: { push: (...w) => w.forEach(warn) },
      });
    } catch (err) {
      if (projectOpen && making) await removeUnfinished(client, making, doc.name, err);
      throw err;
    }
    for (const w of doc.warnings) warn(w);
    if (copyName) results.copied += 1;
    else results.imported += 1;
  }
  onProgress?.({ phase: 'done', ...results });
  return { ...results, warnings };
}
