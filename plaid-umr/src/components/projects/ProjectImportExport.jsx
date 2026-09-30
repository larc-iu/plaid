import JSZip from 'jszip';
import { importTarget, importUmrDocument } from '../../domain/umrImport.js';
import { exportProjectUmr } from '../../domain/umrExport.js';
import { UnwritableUmrError } from '../../domain/format/umrFile.js';
import { ExportProblems } from '../editor/ExportProblems.jsx';
import { getUmrLayerInfo } from '../../utils/umrLayerUtils.js';
import { ProjectImportExportPage } from '@ui/components/shared/ProjectImportExportPage.jsx';
import { ProjectTabs } from './ProjectTabs.jsx';

// What an import is in the audit log, for a reader counting operations by kind.
const IMPORT_KIND = { kind: 'import', ref: 'format:umr' };

const prepareImport = async ({ client, project, projectId }) => {
  // Layer config is the same for every document, so it is read once here and
  // passed in: otherwise the importer re-reads the project per document.
  const layerInfo = getUmrLayerInfo(project);
  let existingDocs = [];
  try {
    existingDocs = await client.projects.listDocuments(projectId);
  } catch (err) {
    console.error('Could not list the documents before importing:', err);
  }

  // One file is one document. A throw is the file's rejected row.
  return async ({ text, index, name, push }) => {
    if (!text.trim()) {
      push({ key: `${index}-empty`, name, status: 'rejected', reason: 'File is empty' });
      return;
    }
    // A document by the file's name with words and no graph takes the file's
    // graphs onto its own words (an IGT document, say). One that already has
    // a graph refuses the file (importTarget). Otherwise the file becomes a
    // new document, with a note when a document of that name was there. One
    // audit-log operation either way, labeled with the document name.
    const matches = (existingDocs || []).filter((d) => d.name === name);
    if (matches.length > 1) {
      throw new Error(
        `${matches.length} documents are named "${name}". Rename the file, or the documents.`,
      );
    }
    const target = matches.length
      ? importTarget(await client.documents.get(matches[0].id, true))
      : { into: null };
    const { into } = target;
    const asNew = (why) => (res) => {
      res.warnings = [`Imported as a new document: ${why}`, ...(res.warnings || [])];
      return res;
    };
    let result;
    try {
      result = await client.withOperation(
        `Import UMR document "${name}"`,
        () => importUmrDocument(client, projectId, name, text, layerInfo, { into }),
        IMPORT_KIND,
      );
      if (target.note) result = asNew(target.note)(result);
    } catch (err) {
      // Words that differ from the document of that name: the file is a
      // document of its own, and the row says why.
      if (!into || !/differs|sentences and the document/.test(err?.message || '')) throw err;
      result = asNew(err.message)(
        await client.withOperation(
          `Import UMR document "${name}"`,
          () => importUmrDocument(client, projectId, name, text, layerInfo),
          IMPORT_KIND,
        ),
      );
    }
    const { warnings, attached } = result;
    push({
      key: `${index}`,
      name,
      status: 'imported',
      attached,
      documentId: result.document?.id,
      warnings: warnings || [],
    });
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
