import JSZip from 'jszip';
import { ConlluDocument } from '../../domain/ConlluDocument.js';
import { importErrorText } from '../../domain/conlluImport.js';
import { splitConlluByNewdoc } from '../../utils/conlluParser.js';
import { getUdLayerInfo } from '../../utils/udLayerUtils.js';
import { humanizeError } from '../../utils/feedback.jsx';
import { NOT_SET_UP_FILE, NOT_TOKENIZED_FILE } from '../../domain/conlluSerialize.js';
import { ProjectImportExportPage } from '@ui/components/shared/ProjectImportExportPage.jsx';
import { ProjectTabs } from './ProjectTabs.jsx';

// `toConllu()` returns a `#`-prefixed sentinel (not a throw) for documents that
// can't be serialized (project unconfigured or no tokenized content). A real
// export begins with `# newdoc id = …`.
const isExportError = (t) => t === NOT_SET_UP_FILE || t === NOT_TOKENIZED_FILE;

// Run `fn` over `items` with at most `limit` in flight. `onProgress(done)`
// fires after each completion.
async function mapWithConcurrency(items, limit, fn, onProgress) {
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
      onProgress(++done);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

const prepareImport = async ({ client, project, projectId }) => {
  // Layer config is the same for every document, so it is read once and passed
  // in. Otherwise importFromConllu re-fetches it (a full includeBody read) per
  // document, which roughly doubles import time on a big set.
  const layerInfo = getUdLayerInfo(project);

  // A file holds one document, or several split at `# newdoc`.
  return async ({ text, index, name: base, push }) => {
    const chunks = splitConlluByNewdoc(text);
    if (chunks.length === 0) {
      push({ key: `${index}-empty`, name: base, status: 'rejected', reason: 'File is empty' });
      return;
    }
    for (let c = 0; c < chunks.length; c++) {
      const chunk = chunks[c];
      const name = chunk.id || (chunks.length > 1 ? `${base} (${c + 1})` : base);
      try {
        // One audit-log operation per imported document (text, tokens and
        // annotations), labeled with the document name, of kind import.
        const { documentId, importWarnings } = await client.withOperation(
          `Import CoNLL-U document "${name}"`,
          () => ConlluDocument.importFromConllu(client, projectId, name, chunk.text, layerInfo),
          { kind: 'import', ref: 'format:conllu' },
        );
        push({
          key: `${index}-${c}`,
          name,
          status: 'imported',
          documentId,
          warnings: importWarnings || [],
        });
      } catch (err) {
        push({ key: `${index}-${c}`, name, status: 'rejected', reason: importErrorText(err) });
      }
    }
  };
};

const exportDocuments = async ({ client, projectId, onProgress }) => {
  const docs = (await client.projects.listDocuments(projectId)) || [];
  if (docs.length === 0) return { documents: 0, entries: [], skipped: [] };
  onProgress(0, docs.length);
  const entries = [];
  const skipped = [];
  await mapWithConcurrency(
    docs,
    5,
    async (d) => {
      try {
        const doc = await ConlluDocument.load(client, projectId, d.id);
        const t = doc.toConllu();
        if (isExportError(t)) {
          skipped.push({ name: d.name, reason: t.replace(/^#\s*/, '') });
        } else {
          entries.push({ name: d.name, text: t });
        }
      } catch (err) {
        skipped.push({ name: d.name, reason: humanizeError(err, 'Failed to load it.') });
      }
    },
    (done) => onProgress(done, docs.length),
  );
  return { documents: docs.length, entries, skipped };
};

const zip = (files) => {
  const archive = new JSZip();
  for (const f of files) archive.file(f.path, f.text);
  return archive.generateAsync({ type: 'blob' });
};

const FORMAT = {
  app: 'UD',
  extension: '.conllu',
  importTitle: 'Import CoNLL-U files',
  exportWhat: 'CoNLL-U files',
  layerInfo: getUdLayerInfo,
  prepareImport,
  exportDocuments,
  zip,
};

const setupHref = (projectId) => `/projects/${projectId}/configuration`;

export const ProjectImportExport = () => (
  <ProjectImportExportPage tabs={ProjectTabs} setupHref={setupHref} format={FORMAT} />
);
