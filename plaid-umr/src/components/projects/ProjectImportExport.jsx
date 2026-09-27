import JSZip from 'jszip';
import { importUmrDocument } from '../../domain/umrImport.js';
import { exportProjectUmr } from '../../domain/umrExport.js';
import { UnwritableUmrError } from '../../domain/format/umrFile.js';
import { ExportProblems } from '../editor/ExportProblems.jsx';
import { getUmrLayerInfo } from '../../utils/umrLayerUtils.js';
import { ProjectImportExportPage } from '@ui/components/shared/ProjectImportExportPage.jsx';
import { ProjectTabs } from './ProjectTabs.jsx';

// A document's id when a .umr file may be imported onto it: it has words and
// no UMR node yet. Null otherwise, and the file makes a new document.
const annotatable = async (client, documentId) => {
  const raw = await client.documents.get(documentId, true);
  const info = getUmrLayerInfo(raw);
  if (!info.isConfigured) return null;
  // Constants (author, root) are not a graph.
  const nodes = (info.conceptLayer.spans || []).filter((sp) => sp.metadata?.umr?.constant !== true);
  if (nodes.length) return null;
  if (!(info.wordTokenLayer.tokens || []).length) return null;
  return documentId;
};

const prepareImport = async ({ client, project, projectId }) => {
  // Layer config is the same for every document, so it is read once here and
  // passed in: otherwise the importer re-reads the project per document.
  const layerInfo = getUmrLayerInfo(project);
  let existingDocs = [];
  // The documents there before each import, for a create whose answer was
  // lost to find the one it made. Unknown when the list could not be read.
  let before = null;
  try {
    existingDocs = await client.projects.listDocuments(projectId);
    before = [...existingDocs];
  } catch (err) {
    console.error('Could not list the documents before importing:', err);
  }

  // One file is one document. A throw is the file's rejected row.
  return async ({ text, index, name, push }) => {
    if (!text.trim()) {
      push({ key: `${index}-empty`, name, status: 'rejected', reason: 'File is empty' });
      return;
    }
    // A document by the file's name that holds no UMR nodes yet takes the
    // file's graphs onto its own words (an IGT document, say). Otherwise the
    // file becomes a new document. One audit-log operation either way, labeled
    // with the document name.
    const matches = (existingDocs || []).filter((d) => d.name === name);
    if (matches.length > 1) {
      throw new Error(
        `${matches.length} documents are named "${name}". Rename the file, or the documents.`,
      );
    }
    const into = matches.length ? await annotatable(client, matches[0].id) : null;
    let result;
    try {
      result = await client.withOperation(`Import UMR document "${name}"`, () =>
        importUmrDocument(client, projectId, name, text, layerInfo, { into, before }),
      );
    } catch (err) {
      // Words that differ from the document of that name: the file is a
      // document of its own, and the row says why.
      if (!into || !/differs|sentences and the document/.test(err?.message || '')) throw err;
      result = await client.withOperation(`Import UMR document "${name}"`, () =>
        importUmrDocument(client, projectId, name, text, layerInfo, { before }),
      );
      result.warnings = [`Imported as a new document: ${err.message}`, ...(result.warnings || [])];
    }
    const { warnings, attached } = result;
    if (before && !attached) before.push(result.document);
    push({ key: `${index}`, name, status: 'imported', attached, warnings: warnings || [] });
  };
};

const exportDocuments = async ({ client, project, projectId, onProgress }) => {
  const entries =
    (await exportProjectUmr(client, projectId, getUmrLayerInfo(project), { onProgress })) || [];
  return { documents: entries.length, entries, skipped: [] };
};

const zip = (files) => {
  const archive = new JSZip();
  for (const f of files) archive.file(f.path, f.text);
  return archive.generateAsync({ type: 'blob' });
};

// A value a .umr file cannot hold refuses the whole export, and the page lists
// each one where the export button is.
const exportFailure = (err) =>
  err instanceof UnwritableUmrError ? <ExportProblems problems={err.problems} /> : null;

const FORMAT = {
  app: 'UMR',
  extension: '.umr',
  accept: '.umr,.txt',
  importTitle: 'Import UMR files',
  exportWhat: (
    <>
      <code className="rounded bg-muted px-1 py-0.5 font-mono">.umr</code> files
    </>
  ),
  layerInfo: getUmrLayerInfo,
  prepareImport,
  exportDocuments,
  zip,
  exportFailure,
};

const setupHref = (projectId) => `/projects/${projectId}/configuration`;

export const ProjectImportExport = () => (
  <ProjectImportExportPage tabs={ProjectTabs} setupHref={setupHref} format={FORMAT} />
);
