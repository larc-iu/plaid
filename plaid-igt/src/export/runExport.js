// Drive a whole export: resolve the document list for the chosen scope,
// fetch documents SEQUENTIALLY (server load, memory), serialize each with the
// preset's format, and assemble the result — a bare file for a single
// document, a zip (documents/ + optional vocabularies/) otherwise. The native
// 'plaid-igt-json' format is special: it ALWAYS produces a zip (project.json
// + vocabularies/*.json + documents/*.json + optional media/*) so the archive
// is self-contained and re-importable regardless of scope.
//
// UI-free and stub-client-testable. Per-document failures become entries in
// `warnings`, not an aborted run; cancellation throws ExportCancelled.

import { IgtDocument, loadProjectVocabularies } from '../domain/IgtDocument.js';
import { readVocabFields } from '../domain/igtConfig.js';
import { discoverExportLayers, intersectSelection } from './exportLayers.js';
import { serializeDocumentPlain } from './plainTextDoc.js';
import { buildFlextextDocument } from './flextext.js';
import { serializeVocabTsv } from './vocabTsv.js';
import { buildProjectFile, serializeVocabularyNative, serializeDocumentNative } from './nativeJson.js';
import { sanitizeFilename, dedupeFilenames, assembleZip } from './files.js';
import { formatExt } from './presets.js';

export class ExportCancelled extends Error {
  constructor() { super('Export cancelled'); this.name = 'ExportCancelled'; }
}

const toJson = (obj) => JSON.stringify(obj, null, 2);

function serializeDoc(igtDoc, preset, layers) {
  if (preset.format === 'flextext') {
    return buildFlextextDocument([igtDoc], preset.options || {});
  }
  // Drop tier names that no longer exist in the project configuration.
  return serializeDocumentPlain(igtDoc, intersectSelection(preset.options || {}, layers));
}

/**
 * Fetch a document's media bytes. Same endpoint and auth as
 * client.documents.getMedia, but issued directly with fetch: the client's
 * _request is bounded by its default 30s timeout, which large media files
 * can easily exceed. (If the media route or auth scheme ever changes, getMedia
 * in plaid-client-js is the reference.)
 */
export async function fetchDocumentMedia(client, documentId, asOf) {
  const qs = asOf ? `?as-of=${encodeURIComponent(asOf)}` : '';
  const res = await fetch(`${client.baseUrl}/api/v1/documents/${documentId}/media${qs}`, {
    headers: { Authorization: `Bearer ${client.token}` },
  });
  if (!res.ok) throw new Error(`media fetch failed (${res.status})`);
  return new Uint8Array(await res.arrayBuffer());
}

// "audio.wav?token=x" → ".wav" ('' when the URL has no extension).
const mediaExtOf = (mediaUrl) => {
  const path = String(mediaUrl).split(/[?#]/)[0];
  const base = path.split('/').filter((s) => s !== '').at(-1) ?? '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot) : '';
};

/**
 * scope: { type: 'project' } | { type: 'documents', ids: [id] } | { type: 'document', id }
 * asOf: ISO timestamp for historical (time-travel) export — only valid with
 * document scope, since the documents-list endpoint rejects `as-of`.
 * onProgress({ done, total, name }) fires before each document fetch.
 * fetchMedia is injectable for tests.
 * Returns { filename, blob, warnings: [string] }.
 */
export async function runExport({
  client, project, preset, scope, asOf = null,
  onProgress = () => {}, shouldStop = () => false,
  fetchMedia = fetchDocumentMedia,
}) {
  const checkStop = () => { if (shouldStop()) throw new ExportCancelled(); };
  const ext = formatExt(preset.format);
  const layers = discoverExportLayers(project);
  const warnings = [];
  const isNative = preset.format === 'plaid-igt-json';
  const includeMedia = isNative && preset.options?.includeMedia !== false;

  // Document id list for the scope.
  let docIds;
  if (scope.type === 'document') docIds = [scope.id];
  else if (scope.type === 'documents') docIds = [...scope.ids];
  else docIds = (await client.projects.listDocuments(project.id)).map((d) => d.id);
  checkStop();

  // Document scope downloads the bare file; project/multi-doc scopes always
  // produce a zip — and the native archive is a zip at every scope.
  const wantZip = isNative || scope.type !== 'document';

  // Vocabularies are fetched for the TSVs (opt-in) or the native archive
  // (always — links reference items by id), and snapshotted BEFORE the
  // document loop: the IgtDocument constructor mutates the vocabularies map
  // it's given (folding in raw-embedded links), so sharing this one with the
  // documents would grow it synthetic empty entries for failed vocabs.
  const wantVocabTsvs = !isNative && !!preset.includeVocabularies && wantZip;
  let vocabs = [];
  if (wantVocabTsvs || isNative) {
    const loaded = await loadProjectVocabularies(client, project, asOf);
    vocabs = Object.values(loaded.vocabularies);
    if (loaded.failedCount) {
      warnings.push(`${loaded.failedCount} vocabular${loaded.failedCount === 1 ? 'y' : 'ies'} failed to load`);
    }
  }
  checkStop();

  // Media archive names must be decided before each doc is serialized (the
  // doc JSON records its own mediaFile path), so dedupe incrementally.
  const usedMediaNames = new Set();
  const mediaEntries = [];

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
    if (includeMedia && igtDoc.raw?.mediaUrl) {
      try {
        const bytes = await fetchMedia(client, docIds[i], asOf);
        let candidate = `${sanitizeFilename(name)}${mediaExtOf(igtDoc.raw.mediaUrl)}`;
        [candidate] = dedupeFilenames([...usedMediaNames, candidate]).slice(-1);
        usedMediaNames.add(candidate);
        mediaFile = `media/${candidate}`;
        // Already-compressed audio/video — store, don't deflate.
        mediaEntries.push({ path: mediaFile, data: bytes, opts: { level: 0 } });
      } catch (err) {
        warnings.push(`"${name}": media could not be fetched: ${err?.message ?? err}`);
      }
    }

    try {
      docFiles.push({
        name: `${sanitizeFilename(name)}.${ext}`,
        data: isNative
          ? toJson(serializeDocumentNative(igtDoc, { mediaFile }))
          : serializeDoc(igtDoc, preset, layers),
        id: igtDoc.document?.id ?? docIds[i],
        docName: name,
        mediaFile,
      });
    } catch (err) {
      warnings.push(`"${name}" failed to serialize: ${err?.message ?? err}`);
    }
  }
  onProgress({ done: docIds.length, total: docIds.length, name: null });
  if (!docFiles.length) {
    throw new Error(warnings.length ? `Nothing exported — ${warnings.join('; ')}` : 'Nothing to export');
  }

  // Single document → the bare file.
  if (!wantZip) {
    const mime = preset.format === 'flextext' ? 'text/xml;charset=utf-8' : 'text/plain;charset=utf-8';
    return {
      filename: docFiles[0].name,
      blob: new Blob([docFiles[0].data], { type: mime }),
      warnings,
    };
  }

  const docNames = dedupeFilenames(docFiles.map((f) => f.name));
  const entries = docNames.map((name, i) => ({ path: `documents/${name}`, data: docFiles[i].data }));

  if (isNative) {
    const vocabNames = dedupeFilenames(vocabs.map((v) => `${sanitizeFilename(v.name || v.id)}.json`));
    vocabs.forEach((vocab, i) => {
      entries.push({ path: `vocabularies/${vocabNames[i]}`, data: toJson(serializeVocabularyNative(vocab)) });
    });
    entries.push(...mediaEntries);
    entries.unshift({
      path: 'project.json',
      data: toJson(buildProjectFile({
        project,
        documents: docFiles.map((f, i) => ({
          id: f.id, name: f.docName, file: `documents/${docNames[i]}`, mediaFile: f.mediaFile,
        })),
        vocabularies: vocabs.map((v, i) => ({ id: v.id, name: v.name, file: `vocabularies/${vocabNames[i]}` })),
        asOf,
        exportedAt: new Date().toISOString(),
      })),
    });
  } else if (wantVocabTsvs) {
    // Vocab TSVs omit usage counts (the UI's counts are cross-project, which
    // would be misleading in a per-project archive).
    const names = dedupeFilenames(vocabs.map((v) => `${sanitizeFilename(v.name || v.id)}.tsv`));
    vocabs.forEach((vocab, i) => {
      const fieldNames = Object.keys(readVocabFields(vocab.config) || {})
        .filter((n) => n.toLowerCase() !== 'form');
      entries.push({
        path: `vocabularies/${names[i]}`,
        data: serializeVocabTsv({ items: vocab.items || [], fieldNames }),
      });
    });
  }
  checkStop();
  const zipStem = scope.type === 'document'
    ? docFiles[0].docName
    : (project.name || 'project');
  return {
    filename: `${sanitizeFilename(zipStem)}-export.zip`,
    blob: await assembleZip(entries),
    warnings,
  };
}
