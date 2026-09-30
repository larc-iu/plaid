import JSZip from 'jszip';
import { exportProjectUmr } from '../../domain/umrExport.js';
import { UnwritableUmrError } from '../../domain/format/umrFile.js';
import { ExportProblems } from '../editor/ExportProblems.jsx';
import { getUmrLayerInfo } from '../../utils/umrLayerUtils.js';
import { ProjectImportExportPage } from '@ui/components/shared/ProjectImportExportPage.jsx';
import { ProjectTabs } from './ProjectTabs.jsx';
import { prepareImport } from './prepareUmrImport.js';

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
