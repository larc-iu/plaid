import { t, tx } from '@ui/lib/i18n.js';
import { setupHref } from './setup.jsx';
import { exportProjectUmr } from '../../domain/umrExport.js';
import { UnwritableUmrError } from '../../domain/format/umrFile.js';
import { ExportProblems } from '../editor/ExportProblems.jsx';
import { getUmrLayerInfo } from '../../utils/umrLayerUtils.js';
import { ProjectImportExportPage } from '@ui/components/shared/ProjectImportExportPage.jsx';
import { zip, unzip } from '@ui/lib/zip.js';
import { ProjectTabs } from './ProjectTabs.jsx';
import { prepareImport } from './prepareUmrImport.js';

const exportDocuments = async ({ client, project, projectId, onProgress }) => {
  const entries = (await exportProjectUmr(client, projectId, project, { onProgress })) || [];
  return { documents: entries.length, entries, skipped: [] };
};

// A value a .umr file cannot hold refuses the whole export, and the page lists
// each one where the export button is.
const exportFailure = (err) =>
  err instanceof UnwritableUmrError ? <ExportProblems problems={err.problems} /> : null;

const code = (text) => <code className="rounded bg-muted px-1 py-0.5 font-mono">{text}</code>;

// The page reads the two lines a person sees when it draws, so they are
// getters: the language is known by then.
const FORMAT = {
  app: 'UMR',
  extension: '.umr',
  accept: '.umr,.txt,.zip',
  get importTitle() {
    return t('Import UMR files');
  },
  get exportNote() {
    return tx('Every document in this project as a <code>.zip</code> of <code>.umr</code> files.', {
      code,
    });
  },
  layerInfo: getUmrLayerInfo,
  prepareImport,
  exportDocuments,
  zip,
  unzip,
  exportFailure,
};

export const ProjectImportExport = () => (
  <ProjectImportExportPage tabs={ProjectTabs} setupHref={setupHref} format={FORMAT} />
);
