// Drive a whole export: resolve the document list for the chosen scope,
// fetch documents SEQUENTIALLY (server load, memory), serialize each with the
// preset's format, and assemble the result — a bare file for a single
// document, a zip (documents/ + optional vocabularies/) otherwise. Three
// formats are dataset-level rather than per-document:
// 'plaid-igt-json' (project.json + vocabularies/*.json + documents/*.json +
// optional media/*, self-contained and re-importable regardless of scope) and
// 'cldf' (cldf-metadata.json + one CSV per component table, with every
// document's sentences folded into a single examples.csv) always produce a
// zip. 'flextext' folds the whole scope into ONE .flextext and pairs it with
// the lexicon as LIFT, so it is a zip whenever there is a lexicon to pair.
//
// UI-free and stub-client-testable. Per-document failures become entries in
// `warnings`, not an aborted run; cancellation throws ExportCancelled.

import { IgtDocument, loadProjectVocabularies } from '../domain/IgtDocument.js';
import { readVocabFields, readLanguages } from '../domain/igtConfig.js';
import { discoverExportLayers, intersectSelection } from './exportLayers.js';
import { serializeDocumentPlain } from './plainTextDoc.js';
import { interlinearTextXml, flextextEnvelope } from './flextext.js';
import { buildLiftLexicon } from './lift.js';
import { buildEafDocument } from './elan.js';
import { serializeVocabTsv } from './vocabTsv.js';
import { buildCldfDataset } from './cldf.js';
import {
  buildProjectFile,
  serializeVocabularyNative,
  serializeDocumentNative,
} from './nativeJson.js';
import { sanitizeFilename, dedupeFilenames, assembleZip } from './files.js';
import { formatExt } from './presets.js';

export class ExportCancelled extends Error {
  constructor() {
    super('Export cancelled');
    this.name = 'ExportCancelled';
  }
}

const toJson = (obj) => JSON.stringify(obj, null, 2);

function serializeDoc(igtDoc, preset, layers, context = {}) {
  // One <interlinear-text> block, not a whole file: the FLEx branch joins the
  // scope's blocks into a single .flextext at assembly time.
  if (preset.format === 'flextext') {
    return interlinearTextXml(igtDoc, preset.options || {});
  }
  if (preset.format === 'elan') {
    return buildEafDocument(igtDoc, intersectSelection(preset.options || {}, layers), context);
  }
  // Drop tier names that no longer exist in the project configuration.
  return serializeDocumentPlain(igtDoc, intersectSelection(preset.options || {}, layers));
}

/**
 * The FLEx archive's own instructions. Its two files have to be imported in
 * order, because the texts name their lexical entries by citation form and the
 * entries must exist first for FLEx to link the two together. Nothing in
 * either file says so.
 */
const flexReadme = ({ stem, lexicon, docCount }) =>
  [
    'Exported from Plaid for FieldWorks Language Explorer (FLEx).',
    '',
    'Contents:',
    `  ${stem}.lift: the lexicon (${lexicon.entryCount} entries, ${lexicon.senseCount} senses)`,
    ...(lexicon.ranges
      ? [`  ${stem}.lift-ranges: the grammatical categories the lexicon uses`]
      : []),
    `  ${stem}.flextext: ${docCount} interlinear text${docCount === 1 ? '' : 's'}`,
    '',
    "Import them in this order, from FLEx's File > Import menu:",
    '',
    `  1. the LIFT lexicon (${stem}.lift)`,
    ...(lexicon.ranges
      ? [`     Keep ${stem}.lift-ranges in the same folder, where FLEx reads it from.`]
      : []),
    `  2. the interlinear texts (${stem}.flextext)`,
    '',
    'The order matters. The texts name their lexical entries by citation form,',
    'so the entries have to be in place before the texts are imported for FLEx',
    'to link them up.',
    '',
  ].join('\n');

// The mediaUrl the server hands out is the bare endpoint path
// (/api/v1/documents/<id>/media — no filename), so the archive filename's
// extension comes from the response Content-Type. Extensions matter: media
// re-upload on import is validated by filename extension server-side.
const MEDIA_EXTS = {
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'audio/wave': '.wav',
  'audio/vnd.wave': '.wav', // what the core serves for .wav uploads
  'audio/mpeg': '.mp3',
  'audio/mp4': '.m4a',
  'audio/aac': '.aac',
  'audio/ogg': '.ogg',
  'audio/flac': '.flac',
  'audio/x-flac': '.flac',
  'audio/webm': '.weba',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/quicktime': '.mov',
  'video/x-msvideo': '.avi',
  'video/mpeg': '.mpg',
};
const extOfContentType = (contentType) => {
  const mime = String(contentType ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  if (MEDIA_EXTS[mime]) return MEDIA_EXTS[mime];
  // Generic fallback: subtype minus x-/vnd. decorations, when it looks like
  // a plausible extension token.
  const subtype = (mime.split('/')[1] ?? '').replace(/^(x-|vnd\.)/, '');
  return /^[a-z0-9-]{1,8}$/.test(subtype) ? `.${subtype}` : '';
};

/**
 * Fetch a document's media. Same endpoint and auth as
 * client.documents.getMedia, but issued directly with fetch: the client's
 * _request is bounded by its default 30s timeout, which large media files
 * can easily exceed. (If the media route or auth scheme ever changes, getMedia
 * in plaid-client-js is the reference.) Returns { bytes, ext }.
 */
export async function fetchDocumentMedia(client, documentId, asOf) {
  const qs = asOf ? `?as-of=${encodeURIComponent(asOf)}` : '';
  const res = await fetch(`${client.baseUrl}/api/v1/documents/${documentId}/media${qs}`, {
    headers: { Authorization: `Bearer ${client.token}` },
  });
  if (!res.ok) throw new Error(`media fetch failed (${res.status})`);
  const contentType = res.headers.get('content-type');
  return {
    bytes: new Uint8Array(await res.arrayBuffer()),
    ext: extOfContentType(contentType),
    // CLDF's MediaTable.Media_Type wants the media type itself, not the
    // extension the archive filename gets.
    mime: String(contentType ?? '')
      .split(';')[0]
      .trim()
      .toLowerCase(),
  };
}

/**
 * A document's comments, shaped for the native serializer, with each author's
 * display name resolved once per export and cached across documents.
 *
 * Only the native archive carries comments; see the export panels for why no
 * interchange format does. A comment whose anchor the archive cannot represent
 * (a relation, owned by another app's layer) is dropped by `commentNodes` and
 * reported here, so the count in the warning is the honest one.
 *
 * A display name that cannot be fetched falls back to null rather than failing
 * the export: the id is the identity, the name is only a label.
 */
export async function loadDocumentComments(client, projectId, documentId, nameCache) {
  const raw = await client.comments.list(projectId, { documentId });
  const names = nameCache ?? new Map();
  for (const c of raw) {
    if (c.authorId && !names.has(c.authorId)) {
      names.set(
        c.authorId,
        await client.users
          .get(c.authorId)
          .then((u) => u?.displayName ?? null)
          .catch(() => null),
      );
    }
  }
  return raw.map((c) => ({
    id: c.id,
    entityType: c.entityType,
    entityId: c.entityId,
    author: { id: c.authorId ?? null, name: names.get(c.authorId) ?? null },
    body: c.body,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  }));
}

/**
 * scope: { type: 'project' } | { type: 'documents', ids: [id] } | { type: 'document', id }
 * asOf: ISO timestamp for historical (time-travel) export — only valid with
 * document scope, since the documents-list endpoint rejects `as-of`.
 * onProgress({ done, total, name }) fires before each document fetch.
 * fetchMedia is injectable for tests.
 * Returns { filename, blob, warnings: [string] }.
 */
export async function runExport({
  client,
  project,
  preset,
  scope,
  asOf = null,
  onProgress = () => {},
  shouldStop = () => false,
  fetchMedia = fetchDocumentMedia,
}) {
  const checkStop = () => {
    if (shouldStop()) throw new ExportCancelled();
  };
  const ext = formatExt(preset.format);
  const layers = discoverExportLayers(project);
  const warnings = [];
  const isNative = preset.format === 'plaid-igt-json';
  const isCldf = preset.format === 'cldf';
  const isElan = preset.format === 'elan';
  const isFlex = preset.format === 'flextext';
  // The FLEx target is both files: the texts as .flextext and the lexicon as
  // LIFT, which is the only one of the two that can carry a lexicon at all.
  const wantLexicon = isFlex && preset.options?.lexicon !== false;
  const includeMedia = (isNative || isCldf || isElan) && preset.options?.includeMedia !== false;
  const exportedAt = new Date().toISOString();

  // Document id list for the scope.
  let docIds;
  if (scope.type === 'document') docIds = [scope.id];
  else if (scope.type === 'documents') docIds = [...scope.ids];
  else docIds = (await client.projects.listDocuments(project.id)).map((d) => d.id);
  checkStop();

  // Document scope downloads the bare file; project/multi-doc scopes always
  // produce a zip — and the native archive is a zip at every scope. A CLDF
  // dataset is a set of files by definition, so it is always a zip too.
  let wantZip = isNative || isCldf || scope.type !== 'document';

  // Vocabularies are fetched for the TSVs (opt-in) or the native archive
  // (always — links reference items by id), and snapshotted BEFORE the
  // document loop: the IgtDocument constructor mutates the vocabularies map
  // it's given (folding in raw-embedded links), so sharing this one with the
  // documents would grow it synthetic empty entries for failed vocabs.
  // The FLEx target says the lexicon in LIFT, so the TSV dump does not apply.
  const wantVocabTsvs = !isNative && !isCldf && !isFlex && !!preset.includeVocabularies && wantZip;
  // CLDF turns the vocabularies into EntryTable/SenseTable, so it needs them
  // loaded whenever its dictionary option is on.
  const wantCldfDictionary = isCldf && preset.options?.dictionary !== false;
  let vocabs = [];
  if (wantVocabTsvs || isNative || wantCldfDictionary || wantLexicon) {
    const loaded = await loadProjectVocabularies(client, project, asOf);
    vocabs = Object.values(loaded.vocabularies);
    if (loaded.failedCount) {
      warnings.push(
        `${loaded.failedCount} vocabular${loaded.failedCount === 1 ? 'y' : 'ies'} failed to load`,
      );
    }
  }
  checkStop();

  // Media archive names must be decided before each doc is serialized (the
  // doc JSON records its own mediaFile path), so dedupe incrementally.
  const usedMediaNames = new Set();
  const mediaEntries = [];
  // Author display names, resolved once per export rather than per document.
  const authorNames = new Map();

  // Sequential per-document fetch + serialize.
  const docFiles = [];
  for (let i = 0; i < docIds.length; i++) {
    checkStop();
    onProgress({ done: i, total: docIds.length, name: null });
    let igtDoc;
    try {
      const raw = await client.documents.get(docIds[i], true, asOf || undefined);
      // Vocab links — including the vocabItem each carries (flextext citation
      // forms) — ride embedded in the document GET; the constructor folds them
      // into the (fresh, per-document) vocabularies map.
      igtDoc = new IgtDocument({ raw, project, vocabularies: {}, client, projectId: project.id });
    } catch (err) {
      warnings.push(`Document ${docIds[i]} failed to load: ${err?.message ?? err}`);
      continue;
    }
    const name = igtDoc.document?.name || docIds[i];
    onProgress({ done: i, total: docIds.length, name });

    let mediaFile = null;
    let mediaEntry = null;
    let mediaType = '';
    if (includeMedia && igtDoc.raw?.mediaUrl) {
      try {
        const { bytes, ext: mediaExt, mime } = await fetchMedia(client, docIds[i], asOf);
        let candidate = `${sanitizeFilename(name)}${mediaExt}`;
        [candidate] = dedupeFilenames([...usedMediaNames, candidate]).slice(-1);
        usedMediaNames.add(candidate);
        mediaFile = `media/${candidate}`;
        mediaType = mime || '';
        // Already-compressed audio/video — store, don't deflate.
        mediaEntry = { path: mediaFile, data: bytes, opts: { level: 0 } };
      } catch (err) {
        warnings.push(`"${name}": media could not be fetched: ${err?.message ?? err}`);
      }
    }

    // Comments ride the native archive only, and never a historical one: they
    // are unaudited (plaid.sql.comment), so there is no state at `asOf` to
    // read. Today's comments in a time-travelled archive would carry today's
    // dates and could anchor to entities that did not yet exist.
    let docComments = [];
    if (isNative && !asOf) {
      try {
        docComments = await loadDocumentComments(client, project.id, docIds[i], authorNames);
        const archivable = docComments.filter((c) => c.entityType !== 'relation').length;
        if (archivable < docComments.length) {
          warnings.push(
            `"${name}": ${docComments.length - archivable} comment(s) on relations were not exported. ` +
              `Relations belong to another app's layers, which this archive does not carry.`,
          );
        }
      } catch (err) {
        warnings.push(`"${name}": comments could not be fetched: ${err?.message ?? err}`);
      }
    }

    try {
      docFiles.push({
        name: `${sanitizeFilename(name)}.${ext}`,
        // A CLDF dataset is assembled from every document at once, so the
        // per-document loop only collects them here.
        data: isCldf
          ? null
          : isNative
            ? toJson(serializeDocumentNative(igtDoc, { mediaFile, comments: docComments }))
            : serializeDoc(igtDoc, preset, layers, {
                exportedAt,
                onWarning: (msg) => warnings.push(`"${name}": ${msg}`),
                // A bundled .eaf lands in documents/ and its media in
                // media/, so the href that resolves climbs one level.
                mediaHref: mediaFile ? `../${mediaFile}` : null,
                mediaType,
              }),
        igtDoc,
        id: igtDoc.document?.id ?? docIds[i],
        docName: name,
        mediaFile,
        mediaType,
      });
      // Staged only on a successful doc serialize — a skipped document must
      // not leave an orphan media file in the archive.
      if (mediaEntry) mediaEntries.push(mediaEntry);
    } catch (err) {
      warnings.push(`"${name}" failed to serialize: ${err?.message ?? err}`);
    }
  }
  onProgress({ done: docIds.length, total: docIds.length, name: null });
  // A single .eaf that came with media becomes a zip, so its RELATIVE_MEDIA_URL
  // resolves to a file that is actually there.
  if (!wantZip && mediaEntries.length) wantZip = true;
  if (!docFiles.length) {
    throw new Error(
      warnings.length ? `Nothing exported. ${warnings.join('; ')}` : 'Nothing to export',
    );
  }

  // FLEx: the whole scope becomes ONE .flextext (one import action in FLEx,
  // not one per document), and the lexicon rides along as LIFT beside it.
  if (isFlex) {
    const stem = sanitizeFilename(
      scope.type === 'document' ? docFiles[0].docName : project.name || 'project',
    );
    const flextext = flextextEnvelope(docFiles.map((f) => f.data));
    const lexicon = wantLexicon
      ? buildLiftLexicon({
          vocabularies: vocabs,
          options: preset.options || {},
          rangesHref: `${stem}.lift-ranges`,
        })
      : null;
    // A project with no lexicon to speak of exports the texts alone rather
    // than an archive built around an empty .lift.
    if (!lexicon?.entryCount) {
      if (scope.type === 'document') {
        return {
          filename: `${stem}.flextext`,
          blob: new Blob([flextext], { type: 'text/xml;charset=utf-8' }),
          warnings,
        };
      }
      checkStop();
      return {
        filename: `${stem}-flex.zip`,
        blob: await assembleZip([{ path: `${stem}.flextext`, data: flextext }]),
        warnings,
      };
    }
    warnings.push(...lexicon.warnings);
    checkStop();
    return {
      filename: `${stem}-flex.zip`,
      blob: await assembleZip([
        { path: `${stem}.flextext`, data: flextext },
        { path: `${stem}.lift`, data: lexicon.lift },
        // FLEx looks for the ranges beside the .lift under the same stem.
        ...(lexicon.ranges ? [{ path: `${stem}.lift-ranges`, data: lexicon.ranges }] : []),
        { path: 'README.txt', data: flexReadme({ stem, lexicon, docCount: docFiles.length }) },
      ]),
      warnings,
    };
  }

  // Single document → the bare file.
  if (!wantZip) {
    const mime = isElan ? 'text/xml;charset=utf-8' : 'text/plain;charset=utf-8';
    return {
      filename: docFiles[0].name,
      blob: new Blob([docFiles[0].data], { type: mime }),
      warnings,
    };
  }

  // CLDF: one dataset built from every document, not a file per document.
  if (isCldf) {
    const { files, warnings: cldfWarnings } = buildCldfDataset({
      project,
      languages: readLanguages(project?.config),
      documents: docFiles.map((f) => ({
        igtDoc: f.igtDoc,
        mediaFile: f.mediaFile,
        mediaType: f.mediaType,
      })),
      vocabularies: vocabs,
      options: preset.options || {},
      exportedAt,
    });
    warnings.push(...cldfWarnings);
    checkStop();
    const stem = scope.type === 'document' ? docFiles[0].docName : project.name || 'project';
    return {
      filename: `${sanitizeFilename(stem)}-cldf.zip`,
      blob: await assembleZip([...files, ...mediaEntries]),
      warnings,
    };
  }

  const docNames = dedupeFilenames(docFiles.map((f) => f.name));
  const entries = docNames.map((name, i) => ({
    path: `documents/${name}`,
    data: docFiles[i].data,
  }));

  if (isElan) entries.push(...mediaEntries);

  if (isNative) {
    const vocabNames = dedupeFilenames(
      vocabs.map((v) => `${sanitizeFilename(v.name || v.id)}.json`),
    );
    vocabs.forEach((vocab, i) => {
      entries.push({
        path: `vocabularies/${vocabNames[i]}`,
        data: toJson(serializeVocabularyNative(vocab)),
      });
    });
    entries.push(...mediaEntries);
    entries.unshift({
      path: 'project.json',
      data: toJson(
        buildProjectFile({
          project,
          documents: docFiles.map((f, i) => ({
            id: f.id,
            name: f.docName,
            file: `documents/${docNames[i]}`,
            mediaFile: f.mediaFile,
          })),
          vocabularies: vocabs.map((v, i) => ({
            id: v.id,
            name: v.name,
            file: `vocabularies/${vocabNames[i]}`,
          })),
          asOf,
          exportedAt,
        }),
      ),
    });
  } else if (wantVocabTsvs) {
    // Vocab TSVs omit usage counts (the UI's counts are cross-project, which
    // would be misleading in a per-project archive).
    const names = dedupeFilenames(vocabs.map((v) => `${sanitizeFilename(v.name || v.id)}.tsv`));
    vocabs.forEach((vocab, i) => {
      const fieldNames = Object.keys(readVocabFields(vocab.config) || {}).filter(
        (n) => n.toLowerCase() !== 'form',
      );
      entries.push({
        path: `vocabularies/${names[i]}`,
        data: serializeVocabTsv({ items: vocab.items || [], fieldNames }),
      });
    });
  }
  checkStop();
  const zipStem = scope.type === 'document' ? docFiles[0].docName : project.name || 'project';
  return {
    filename: `${sanitizeFilename(zipStem)}-export.zip`,
    blob: await assembleZip(entries),
    warnings,
  };
}
