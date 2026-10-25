import { setupHref } from './setup.jsx';
import { ConlluDocument } from '../../domain/ConlluDocument.js';
import { importErrorText } from '../../domain/conlluImport.js';
import { splitConlluByNewdoc } from '../../utils/conlluParser.js';
import { getUdLayerInfo } from '../../utils/udLayerUtils.js';
import { humanizeError } from '../../utils/feedback.jsx';
import { NOT_SET_UP_FILE, NOT_TOKENIZED_FILE } from '../../domain/conlluSerialize.js';
import { ProjectImportExportPage } from '@ui/components/shared/ProjectImportExportPage.jsx';
import { zip, unzip } from '@ui/lib/zip.js';
import { readInOrder } from '@ui/lib/documentReads.js';
import { ProjectTabs } from './ProjectTabs.jsx';

// `toConllu()` returns a `#`-prefixed sentinel (not a throw) for documents that
// can't be serialized (project unconfigured or no tokenized content). A real
// export begins with `# newdoc id = …`.
const isExportError = (t) => t === NOT_SET_UP_FILE || t === NOT_TOKENIZED_FILE;

// Per document of a file, the id its new document is created under, kept
// while the page is open across every import of that file (the same name,
// size and time), so an import made again after a create whose answer was
// lost names the same id and cannot make a second document (createOnce.js).
// Dropped once the document is imported.
const mints = new Map();
const mintOf = (key) => {
  if (!mints.has(key)) mints.set(key, { current: null });
  return mints.get(key);
};

const prepareImport = async ({ client, project, projectId }) => {
  // Layer config is the same for every document, so it is read once and passed
  // in. Otherwise importFromConllu re-fetches it (a full includeBody read) per
  // document, which roughly doubles import time on a big set.
  const layerInfo = getUdLayerInfo(project);

  // A file holds one document, or several split at `# newdoc`.
  return async ({ file, text, index, name: base, push }) => {
    const chunks = splitConlluByNewdoc(text);
    if (chunks.length === 0) {
      push({ key: `${index}-empty`, name: base, status: 'rejected', reason: 'File is empty' });
      return;
    }
    for (let c = 0; c < chunks.length; c++) {
      const chunk = chunks[c];
      const name = chunk.id || (chunks.length > 1 ? `${base} (${c + 1})` : base);
      const key = [projectId, base, c, name, file?.size ?? '', file?.lastModified ?? ''].join('\n');
      try {
        // One audit-log operation per imported document, which the import
        // labels itself (conlluImport.js).
        const { documentId, importWarnings } = await ConlluDocument.importFromConllu(
          client,
          projectId,
          name,
          chunk.text,
          layerInfo,
          { mint: mintOf(key) },
        );
        mints.delete(key);
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
  // Four reads at a time (readInOrder's bound), the documents taken in the
  // project's order.
  const reads = readInOrder(docs, (d) =>
    ConlluDocument.load(client, { projectId, documentId: d.id }),
  );
  let done = 0;
  for await (const { id: d, value: doc, error } of reads) {
    try {
      if (error) throw error;
      const t = doc.toConllu();
      if (isExportError(t)) {
        skipped.push({ name: d.name, reason: t.replace(/^#\s*/, '') });
      } else {
        entries.push({ name: d.name, text: t });
      }
    } catch (err) {
      skipped.push({ name: d.name, reason: humanizeError(err, 'Failed to load it.') });
    }
    onProgress(++done, docs.length);
  }
  return { documents: docs.length, entries, skipped };
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
  unzip,
};

export const ProjectImportExport = () => (
  <ProjectImportExportPage tabs={ProjectTabs} setupHref={setupHref} format={FORMAT} />
);
