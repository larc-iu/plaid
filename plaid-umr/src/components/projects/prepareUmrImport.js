// One import of UMR files into a project, file by file, for the Import and
// export page (ProjectImportExport.jsx).
import { importTarget, importUmrDocument } from '../../domain/umrImport.js';
import { getUmrLayerInfo } from '../../utils/umrLayerUtils.js';

// What an import is in the audit log, for a reader counting operations by kind.
const IMPORT_KIND = { kind: 'import', ref: 'format:umr' };

export const prepareImport = async ({ client, project, projectId }) => {
  // Layer config is the same for every document, so it is read once here and
  // passed in: otherwise the importer re-reads the project per document.
  const layerInfo = getUmrLayerInfo(project);
  let existingDocs = [];
  // Per file of this import, the id its new document is created under, kept
  // across the attempts at that file so a second cannot make a second
  // document (createOnce.js).
  const mints = new Map();
  const mintOf = (name) => {
    if (!mints.has(name)) mints.set(name, { current: null });
    return mints.get(name);
  };
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
        () =>
          importUmrDocument(client, projectId, name, text, layerInfo, { into, mint: mintOf(name) }),
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
          () => importUmrDocument(client, projectId, name, text, layerInfo, { mint: mintOf(name) }),
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
