// Drive a whole export: resolve the document list for the chosen scope,
// fetch documents SEQUENTIALLY (server load, memory), serialize each with the
// preset's format, and assemble the result — a bare file for a single
// document, a zip (documents/ + optional vocabularies/) otherwise.
//
// UI-free and stub-client-testable. Per-document failures become entries in
// `warnings`, not an aborted run; cancellation throws ExportCancelled.

import { IgtDocument, loadProjectVocabularies } from '../domain/IgtDocument.js';
import { readVocabFields } from '../domain/igtConfig.js';
import { discoverExportLayers, intersectSelection } from './exportLayers.js';
import { serializeDocumentPlain } from './plainTextDoc.js';
import { buildFlextextDocument } from './flextext.js';
import { serializeVocabTsv } from './vocabTsv.js';
import { sanitizeFilename, dedupeFilenames, assembleZip } from './files.js';
import { formatExt } from './presets.js';

export class ExportCancelled extends Error {
  constructor() { super('Export cancelled'); this.name = 'ExportCancelled'; }
}

function serializeDoc(igtDoc, preset, layers) {
  if (preset.format === 'flextext') {
    return buildFlextextDocument([igtDoc], preset.options || {});
  }
  // Drop tier names that no longer exist in the project configuration.
  return serializeDocumentPlain(igtDoc, intersectSelection(preset.options || {}, layers));
}

/**
 * scope: { type: 'project' } | { type: 'documents', ids: [id] } | { type: 'document', id }
 * onProgress({ done, total, name }) fires before each document fetch.
 * Returns { filename, blob, warnings: [string] }.
 */
export async function runExport({
  client, project, preset, scope,
  onProgress = () => {}, shouldStop = () => false,
}) {
  const checkStop = () => { if (shouldStop()) throw new ExportCancelled(); };
  const ext = formatExt(preset.format);
  const layers = discoverExportLayers(project);
  const warnings = [];

  // Document id list for the scope.
  let docIds;
  if (scope.type === 'document') docIds = [scope.id];
  else if (scope.type === 'documents') docIds = [...scope.ids];
  else docIds = (await client.projects.listDocuments(project.id)).map((d) => d.id);
  checkStop();

  // Document scope downloads the bare file; project/multi-doc scopes always
  // produce a zip (predictable shape regardless of document count).
  const wantZip = scope.type !== 'document';

  // Vocabularies are fetched only for the TSVs. Vocab links — including the
  // vocabItem each carries (flextext citation forms) — ride embedded in every
  // document GET and are folded in by the IgtDocument constructor.
  const wantVocabTsvs = !!preset.includeVocabularies && wantZip;
  let vocabularies = {};
  if (wantVocabTsvs) {
    const loaded = await loadProjectVocabularies(client, project);
    vocabularies = loaded.vocabularies;
    if (loaded.failedCount) {
      warnings.push(`${loaded.failedCount} vocabular${loaded.failedCount === 1 ? 'y' : 'ies'} failed to load`);
    }
  }
  checkStop();

  // Sequential per-document fetch + serialize.
  const docFiles = [];
  for (let i = 0; i < docIds.length; i++) {
    checkStop();
    onProgress({ done: i, total: docIds.length, name: null });
    let igtDoc;
    try {
      const raw = await client.documents.get(docIds[i], true);
      igtDoc = new IgtDocument({ raw, project, vocabularies, client, projectId: project.id });
    } catch (err) {
      warnings.push(`Document ${docIds[i]} failed to load: ${err?.message ?? err}`);
      continue;
    }
    const name = igtDoc.document?.name || docIds[i];
    onProgress({ done: i, total: docIds.length, name });
    try {
      docFiles.push({
        name: `${sanitizeFilename(name)}.${ext}`,
        data: serializeDoc(igtDoc, preset, layers),
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

  // Multi-document → zip. Vocab TSVs omit usage counts (the UI's counts are
  // cross-project, which would be misleading in a per-project archive).
  const entries = dedupeFilenames(docFiles.map((f) => f.name))
    .map((name, i) => ({ path: `documents/${name}`, data: docFiles[i].data }));
  if (wantVocabTsvs) {
    const vocabs = Object.values(vocabularies);
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
  return {
    filename: `${sanitizeFilename(project.name || 'project')}-export.zip`,
    blob: await assembleZip(entries),
    warnings,
  };
}
