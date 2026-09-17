// How a round trip runs each format: the export the app would make with every
// option on, and the import a person would get by accepting what the import
// screen suggests.
//
// Both halves call the app's own code in the order its screens do. Export is
// `runExport` with the preset the Export presets screen creates
// (ExportPresetsSettings.jsx), and import is the screen's read, build and
// setup-data derivation followed by the run that useProjectImportRun makes:
// project setup, the import record, the engine, the record cleared. Where a
// screen asks a question (a CLDF column's mapping, an ELAN tier's role) the
// runner takes the answer the screen pre-fills.
//
//   exportProject(client, projectId, formatId) -> {bytes, warnings}
//   importProject(client, formatId, bytes, name) -> {projectId, warnings, notes}

import { File } from 'node:buffer';
import { unzipSync } from 'fflate';
import { executeProjectSetup } from '../../src/components/projects/setup/executeSetup.js';
import {
  markImportFinished,
  markImportStarted,
  readLanguages,
} from '../../src/domain/igtConfig.js';
import { discoverExportLayers } from '../../src/export/exportLayers.js';
import { newPreset } from '../../src/export/presets.js';
import { runExport } from '../../src/export/runExport.js';
import { buildCldfDocuments, deriveImportOptions } from '../../src/import/cldf/buildDocuments.js';
import {
  deriveSetupData as cldfSetupData,
  runCldfImport,
} from '../../src/import/cldf/importEngine.js';
import { readCldfDataset } from '../../src/import/cldf/readDataset.js';
import {
  buildElanDocuments,
  defaultFieldName,
  matchMediaFiles,
} from '../../src/import/elan/buildDocuments.js';
import {
  deriveSetupData as elanSetupData,
  runElanImport,
} from '../../src/import/elan/importEngine.js';
import { readEaf } from '../../src/import/elan/readEaf.js';
import { compareSchemas, suggestRoles, validateRoles } from '../../src/import/elan/schema.js';
import {
  deriveSetupData as nativeSetupData,
  runNativeImport,
} from '../../src/import/native/importEngine.js';
import { readNativeArchive } from '../../src/import/native/readArchive.js';

/** The export format id each round-trip format is written with. */
export const EXPORT_FORMAT = { native: 'plaid-igt-json', cldf: 'cldf', elan: 'elan' };

async function exportScope(client, projectId, formatId, scope) {
  const project = await client.projects.get(projectId);
  const preset = newPreset(
    EXPORT_FORMAT[formatId],
    discoverExportLayers(project),
    'Fidelity',
    readLanguages(project.config),
  );
  const result = await runExport({ client, project, preset, scope });
  return {
    bytes: new Uint8Array(await result.blob.arrayBuffer()),
    filename: result.filename,
    warnings: result.warnings,
  };
}

export const exportProject = (client, projectId, formatId) =>
  exportScope(client, projectId, formatId, { type: 'project' });

export const exportDocument = (client, projectId, documentId, formatId) =>
  exportScope(client, projectId, formatId, { type: 'document', id: documentId });

// useProjectImportRun's `start`, without the React state: setup, the import
// record written as soon as the project exists and again once the lexicon is
// known, the engine, and the record cleared.
async function runProjectImport(client, { kind, source, setupData, vocabId = null, run }) {
  const pending = [];
  const setup = await executeProjectSetup({
    client,
    isNewProject: true,
    resumeProjectId: null,
    setupData,
    onProjectCreated: (id) => pending.push(markImportStarted(client, id, kind, source)),
  });
  await Promise.all(pending);
  if (setup.failures.length > 0) throw new Error(`setup failed: ${setup.failures.join('. ')}`);
  const projectId = setup.projectId;
  const vocab = typeof vocabId === 'function' ? await vocabId({ projectId, setup }) : vocabId;
  await markImportStarted(client, projectId, kind, source, vocab);
  const res = await run({ projectId, vocabId: vocab, shouldStop: () => false });
  if (!(await markImportFinished(client, projectId))) {
    throw new Error('the import record could not be cleared');
  }
  return { projectId, warnings: res?.warnings ?? [] };
}

async function importNative(client, bytes, name) {
  const archive = readNativeArchive(bytes);
  return runProjectImport(client, {
    kind: 'Plaid IGT archive',
    source: archive.manifest?.project?.name ?? null,
    setupData: nativeSetupData(archive.manifest, name),
    run: ({ projectId, shouldStop }) => runNativeImport({ client, projectId, archive, shouldStop }),
  });
}

async function importCldf(client, bytes, name) {
  const dataset = readCldfDataset(bytes);
  const build = buildCldfDocuments(dataset, deriveImportOptions(dataset));
  const out = await runProjectImport(client, {
    kind: 'CLDF',
    source: dataset.title ?? null,
    setupData: cldfSetupData(build, name),
    vocabId: async ({ projectId }) =>
      ((await client.projects.get(projectId)).vocabs || [])[0]?.id ?? null,
    run: ({ projectId, shouldStop }) => runCldfImport({ client, projectId, build, shouldStop }),
  });
  return { ...out, warnings: [...(dataset.warnings || []), ...out.warnings] };
}

const EAF = /\.eaf$/i;

// A zip's entries, or a single .eaf written bare (a one-document export with no
// recording is not zipped).
const isZip = (bytes) => bytes[0] === 0x50 && bytes[1] === 0x4b;

async function importElan(client, bytes, name) {
  const entries = isZip(bytes) ? unzipSync(bytes) : { [`${name}.eaf`]: bytes };
  const paths = Object.keys(entries).sort();
  const decoder = new TextDecoder();
  const files = paths
    .filter((p) => EAF.test(p))
    .map((p) => readEaf(decoder.decode(entries[p]), p.split('/').pop()));
  const media = paths
    .filter((p) => !EAF.test(p) && !p.endsWith('/'))
    .map((p) => new File([entries[p]], p.split('/').pop()));
  if (!files.length) throw new Error('the ELAN export holds no .eaf file');

  // The screen refuses a batch whose files differ in tier structure, and asks
  // about tier names that differ only in spelling. Keeping those apart is the
  // choice that decides nothing on the files' behalf.
  const notes = [];
  const comparison = compareSchemas(files);
  if (comparison.nearMisses?.length) {
    notes.push(`near-miss tier names kept apart: ${JSON.stringify(comparison.nearMisses)}`);
  }
  if (!comparison.consistent) {
    const why = comparison.differences
      .map((d) => `${d.files.join(', ')}: missing [${d.missing}] extra [${d.extra}]`)
      .join('; ');
    throw new Error(`the ELAN import refuses the batch, tier structures differ: ${why}`);
  }
  const nodes = comparison.nodes;
  const roles = suggestRoles(nodes);
  const problems = validateRoles(nodes, roles);
  if (problems.length) {
    throw new Error(`the suggested tier roles are refused: ${JSON.stringify(problems)}`);
  }
  const fieldNames = Object.fromEntries(nodes.map((n) => [n.key, defaultFieldName(n)]));
  const matched = matchMediaFiles(files, media);
  if (matched.missing.length) notes.push(`recordings no file supplied: ${matched.missing}`);
  if (matched.unmatched.length) {
    notes.push(`recordings no .eaf names: ${matched.unmatched.map((f) => f.name)}`);
  }
  const build = buildElanDocuments(files, nodes, roles, {
    fieldNames,
    mediaByFile: matched.byFile,
  });
  const out = await runProjectImport(client, {
    kind: 'ELAN',
    source: null,
    setupData: elanSetupData(build, name),
    run: ({ projectId, shouldStop }) => runElanImport({ client, projectId, build, shouldStop }),
  });
  return { ...out, notes };
}

export async function importProject(client, formatId, bytes, name) {
  const run = { native: importNative, cldf: importCldf, elan: importElan }[formatId];
  if (!run) throw new Error(`no import driver for ${formatId}`);
  const out = await run(client, bytes, name);
  return { notes: [], ...out };
}
